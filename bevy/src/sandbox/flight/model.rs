//! The flight model of an aircraft flown as a flight: the sandbox's fixed-wing aerodynamics (`physics.rs`) with what
//! getting from one runway to another takes on top — flaps and slats, spoilers, spooling engines and reversers, fuel
//! burn, ground effect, and a landing gear that rolls: tyres that grip sideways, nose wheel steering, wheel brakes and
//! the autobrake, rotation about the main wheels, the tail on the runway if pulled too far.
//!
//! Frames as in `physics.rs`: forward −Z, up +Y, right +X; world up is +Y near the floating origin.

use bevy::prelude::*;

use super::types::{Engine, KT, Law, Type};
use crate::physics::{AirData, G, Surfaces, atmosphere, attitude};

const RHO0: f32 = 1.225;

/// Autobrake decelerations (m/s²): LO, MED, MAX.
pub const AUTOBRAKE: [f32; 3] = [1.7, 3.0, 6.0];

/// The aircraft's systems and what the flight model keeps between steps.
#[derive(Component)]
pub struct Aircraft {
    pub ty: &'static Type,
    pub fuel: f32,
    pub payload: f32,
    /// Thrust levers 0..1 (idle to take-off/go-around; a fighter's afterburner from 0.9).
    pub lever: f32,
    /// Engine speed: N1 (fraction) for a turbofan, rpm over the redline for a piston engine.
    pub n1: f32,
    pub reverse: bool,
    pub rev: f32,
    pub flap_lever: usize,
    pub flap: f32,
    pub speedbrake: f32,
    pub spoilers_armed: bool,
    pub spoiler: f32,
    pub gear_lever: bool,
    pub gear: f32,
    pub brakes: f32,
    pub park: bool,
    /// 0 off, 1..3 LO/MED/MAX.
    pub autobrake: u8,
    pub autobrake_on: bool,
    /// A light aircraft's pitch trim: the angle of attack (rad) it settles at hands off.
    pub trim: f32,
    pub on_ground: bool,
    pub tail_strike: bool,
    /// Fuel flow (kg/s), exhaust gas temperature (°C), and this step's thrust (N).
    pub ff: f32,
    pub egt: f32,
    pub thrust: f32,
    /// Fuel burned so far (kg). The tanks never run dry: the burn is only counted, for the landing report.
    pub burned: f32,
    /// Equivalent airspeed (m/s) and load factor.
    pub eas: f32,
    pub nz: f32,
    /// Seconds on the wheels (0 in the air), and since the last touchdown.
    pub rolling: f32,
    pub events: Vec<Event>,
}

/// Something the flight model reports once.
#[derive(Clone, Copy, Debug)]
pub enum Event {
    Liftoff,
    /// Sink rate (m/s), bank and pitch (rad), crab (heading off track, rad), indicated airspeed (kt).
    Touchdown { sink: f32, bank: f32, pitch: f32, crab: f32, ias: f32 },
    Crash(&'static str),
    TailStrike,
}

impl Aircraft {
    pub fn new(ty: &'static Type, fuel: f32, payload: f32, on_ground: bool) -> Self {
        let idle = match ty.engine {
            Engine::Glider => 0.0,
            Engine::Fan { idle, .. } => idle,
            Engine::Prop { idle_rpm, max_rpm, .. } => idle_rpm / max_rpm,
        };
        Aircraft {
            ty,
            fuel: fuel.clamp(0.0, ty.fuel_max),
            payload: payload.max(0.0),
            lever: 0.0,
            n1: idle,
            reverse: false,
            rev: 0.0,
            flap_lever: if on_ground { ty.flaps_takeoff } else { 0 },
            flap: if on_ground { ty.flaps_takeoff as f32 } else { 0.0 },
            speedbrake: 0.0,
            spoilers_armed: on_ground && ty.spoiler_cd > 0.0,
            spoiler: 0.0,
            gear_lever: on_ground || !ty.gear_retracts,
            gear: if on_ground || !ty.gear_retracts { 1.0 } else { 0.0 },
            brakes: 0.0,
            park: false,
            autobrake: if ty.autobrake && on_ground { 3 } else { 0 },
            autobrake_on: false,
            trim: 0.06,
            on_ground,
            tail_strike: false,
            ff: 0.0,
            egt: 0.0,
            thrust: 0.0,
            burned: 0.0,
            eas: 0.0,
            nz: 1.0,
            rolling: 0.0,
            events: Vec::new(),
        }
    }

    pub fn mass(&self) -> f32 {
        self.ty.oew + self.payload + self.fuel
    }

    #[cfg(test)]
    pub fn idle(&self) -> f32 {
        match self.ty.engine {
            Engine::Glider => 0.0,
            Engine::Fan { idle, .. } => idle,
            Engine::Prop { idle_rpm, max_rpm, .. } => idle_rpm / max_rpm,
        }
    }

    /// The stall angle of attack at the flaps' position (rad).
    pub fn alpha_stall(&self) -> f32 {
        let (cl0, cl_max, _) = self.ty.flap_at(self.flap);
        (cl_max - cl0) / self.ty.cl_alpha
    }
}

/// The pilot's (or the autopilot's) hands and feet this step.
#[derive(Clone, Copy, Default)]
pub struct Input {
    /// Stick: pitch up and roll right positive, −1..1; pedals: yaw left positive.
    pub pitch: f32,
    pub roll: f32,
    pub yaw: f32,
    /// Nose wheel tiller, left positive.
    pub tiller: f32,
}

/// Where the aircraft is: the air's own velocity, its altitude, and the ground under its wheels (world y), with the
/// offset from its origin down to the wheels.
#[derive(Clone, Copy)]
pub struct Env {
    pub wind: Vec3,
    pub alt: f32,
    pub ground: f32,
    pub bottom: f32,
}

fn lift_coefficient(alpha: f32, cl0: f32, cl_alpha: f32, cl_max: f32) -> f32 {
    let stall = (cl_max - cl0) / cl_alpha;
    let cl = if alpha <= stall && alpha >= -stall {
        cl0 + cl_alpha * alpha
    } else {
        // Past the stall the lift falls away toward that of a flat plate.
        let a = alpha.abs();
        let past = ((a - stall) / 0.35).min(1.0);
        let plate = (2.0 * a).sin() * 0.9;
        (cl_max * (1.0 - past) + plate * past) * alpha.signum()
    };
    cl.clamp(-cl_max, cl_max)
}

/// Thrust (N, along the nose; negative in reverse) and fuel flow (kg/s) at the engines' speed, and moves them toward
/// the levers.
fn engines(ac: &mut Aircraft, tas: f32, alt: f32, mach: f32, dt: f32) -> f32 {
    let (rho, _) = atmosphere(alt);
    let sigma = rho / RHO0;
    let starved = ac.fuel <= 0.0;
    match ac.ty.engine {
        Engine::Glider => { ac.n1 = 0.0; ac.ff = 0.0; ac.egt = 0.0; 0.0 },
        Engine::Fan { thrust, thrust_ab, idle, tsfc, reverse, spool, .. } => {
            let dry = if thrust_ab > 0.0 { (ac.lever / 0.9).min(1.0) } else { ac.lever };
            let target = if starved { 0.0 } else { idle + (1.0 - idle) * dry * if ac.rev > 0.5 { 0.85 } else { 1.0 } };
            // Slow to spool up from idle, quicker once turning.
            let tau = spool * if ac.n1 < 0.5 { 1.6 } else { 1.0 };
            ac.n1 += (target - ac.n1) * (dt / tau).min(1.0);
            let frac = if ac.n1 <= idle { 0.035 * ac.n1 / idle } else { 0.035 + 0.965 * ((ac.n1 - idle) / (1.0 - idle)).powf(1.4) };
            let lapse = sigma.powf(0.75) * (1.0 - 1.1 * mach + 0.7 * mach * mach);
            let mut t = thrust * frac * lapse;
            if thrust_ab > 0.0 && ac.lever > 0.9 && !starved {
                t += (thrust_ab - thrust) * (ac.lever - 0.9) / 0.1 * lapse;
            }
            ac.ff = if starved { 0.0 } else { tsfc * t.max(thrust * 0.03 * lapse) * if ac.lever > 0.9 && thrust_ab > 0.0 { 2.5 } else { 1.0 } };
            ac.egt = 380.0 + 520.0 * ac.n1 * ac.n1 + if ac.lever > 0.9 && thrust_ab > 0.0 { 150.0 } else { 0.0 };
            let _ = tas;
            t * (1.0 - ac.rev) - t * ac.rev * reverse
        }
        Engine::Prop { power, static_thrust, eta, bsfc, idle_rpm, max_rpm } => {
            let idle = idle_rpm / max_rpm;
            // A fixed-pitch propeller: the rpm follows the throttle and the airspeed windmills it up a little.
            let target = if starved { (tas / 90.0).min(0.35) } else { (idle + (1.0 - idle) * ac.lever * 0.93 + tas / 700.0).min(1.08) };
            ac.n1 += (target - ac.n1) * (dt / 0.8).min(1.0);
            let manifold = ((sigma * 1.13 - 0.13) / 1.0).clamp(0.0, 1.0);
            let p = if starved { 0.0 } else { power * (((ac.n1 - idle) / (1.0 - idle)).clamp(0.0, 1.05)).powf(1.5) * manifold };
            ac.ff = bsfc * p.max(power * 0.06);
            ac.egt = 900.0 + 500.0 * ac.n1;
            (static_thrust * p / power).min(eta * p / tas.max(1.0))
        }
    }
}

/// One step: forces in the world frame, rotations through the control law in the air, the landing gear on the ground.
pub fn step(ac: &mut Aircraft, tf: &mut Transform, velocity: &mut Vec3, omega: &mut Vec3, input: Input, env: Env, dt: f32) -> AirData {
    let ty = ac.ty;
    let mass = ac.mass();

    // Actuators: the flaps take a few seconds per position, the gear about ten, the spoilers a second.
    let flap_to = ac.flap_lever as f32;
    ac.flap += (flap_to - ac.flap).clamp(-dt / 5.0, dt / 5.0);
    let gear_to = if ac.gear_lever || !ty.gear_retracts { 1.0 } else { 0.0 };
    ac.gear += (gear_to - ac.gear).clamp(-dt / 9.0, dt / 9.0);
    let idle_levers = ac.lever < 0.05;
    // Ground spoilers: armed, on the wheels, levers at idle and rolling fast (a landing, or a rejected take-off).
    let ground_spoilers = ac.on_ground && ty.spoiler_cd > 0.0 && (ac.spoilers_armed && idle_levers && ac.rolling > 0.3 && velocity.length() > 20.0 || ac.reverse);
    let spoiler_to = if ground_spoilers { 1.0 } else { ac.speedbrake * if ac.on_ground { 1.0 } else { 0.6 } };
    ac.spoiler += (spoiler_to - ac.spoiler).clamp(-dt, dt);
    let rev_to = if ac.reverse && ac.on_ground && idle_levers.then_some(()).is_some() || ac.reverse && ac.on_ground { 1.0 } else { 0.0 };
    ac.rev += (rev_to - ac.rev).clamp(-dt / 2.0, dt / 2.0);
    if !matches!(ty.engine, Engine::Fan { reverse, .. } if reverse > 0.0) {
        ac.rev = 0.0;
    }

    // Aerodynamics.
    let rot = tf.rotation;
    let (fwd, up, right) = (rot * Vec3::NEG_Z, rot * Vec3::Y, rot * Vec3::X);
    let air = *velocity - env.wind;
    let speed = air.length();
    let (rho, sound) = atmosphere(env.alt);
    let q = 0.5 * rho * speed * speed;
    ac.eas = speed * (rho / RHO0).sqrt();
    let body = rot.inverse() * air;
    let (alpha, beta) = if speed > 1.0 { ((-body.y).atan2((-body.z).max(0.1)), (body.x / speed).clamp(-1.0, 1.0).asin()) } else { (0.0, 0.0) };
    let (cl0, cl_max, cd_flap) = ty.flap_at(ac.flap);
    let height = (tf.translation.y + env.bottom - env.ground).max(0.0);
    // Ground effect: within a span of the ground the wing's downwash is cushioned — more lift, less induced drag.
    let hb = height / ty.span;
    let ge = (16.0 * hb * hb) / (1.0 + 16.0 * hb * hb);
    let cl = lift_coefficient(alpha, cl0, ty.cl_alpha, cl_max) * (1.0 + 0.08 * (1.0 - ge)) * (1.0 - ty.spoiler_dump * ac.spoiler);
    let mach = speed / sound;
    let wave = if ty.is_jet() { 0.035 * ((mach - 0.8) / 0.25).clamp(0.0, 1.0) - 0.012 * ((mach - 1.2) / 0.6).clamp(0.0, 1.0) } else { 0.0 };
    let cd = ty.cd0 + cd_flap + ty.k * ge.max(0.3) * cl * cl + wave + ty.cd_gear * ac.gear + ty.spoiler_cd * ac.spoiler + 1.2 * (alpha.abs() - 0.15).max(0.0).sin().powi(2);
    let vhat = air.normalize_or_zero();
    let lift = right.cross(vhat).normalize_or_zero() * q * ty.wing_area * cl;
    let drag = -vhat * q * ty.wing_area * cd;
    let side = -right * q * ty.wing_area * ty.cy_beta * beta;
    ac.thrust = engines(ac, speed, env.alt, mach, dt);
    ac.burned += ac.ff * dt;
    let aero = lift + drag + side + fwd * ac.thrust;
    let force = aero + Vec3::NEG_Y * G * mass;
    ac.nz = aero.dot(up) / (mass * G);
    let authority = (q / ty.q_full).clamp(0.03, 1.0);
    let alpha_stall = (cl_max - cl0) / ty.cl_alpha;
    let stalled = alpha > alpha_stall && !ac.on_ground;

    let (pitch, bank) = attitude(rot);
    let surfaces = Surfaces {
        pitch: input.pitch,
        roll: input.roll,
        yaw: input.yaw,
        flap: ac.flap / (ty.flaps.len() - 1).max(1) as f32,
        droop: if ac.flap > 0.5 { 1.0 } else { 0.0 },
        brake: ac.spoiler,
    };

    if ac.on_ground {
        ac.rolling += dt;
        // Weight on the wheels: whatever of the aircraft's weight the wings do not carry yet.
        let normal = (-force.y).max(0.0);
        let wow = (normal / (mass * G)).clamp(0.0, 1.0);
        let yaw = crate::sandbox::yaw_of(rot);
        let fwd_h = Quat::from_rotation_y(yaw) * Vec3::NEG_Z;
        let right_h = Quat::from_rotation_y(yaw) * Vec3::X;
        let mut along = velocity.dot(fwd_h);
        let mut lateral = velocity.dot(right_h);
        // Wheel brakes (the pedals, the parking brake, the autobrake), limited by the tyres' grip; rolling friction.
        let grip = ty.brake_mu * normal / mass;
        let mut brake = (ac.brakes.max(if ac.park { 1.0 } else { 0.0 }) * grip).min(grip);
        if ac.autobrake > 0 && ac.brakes < 0.3 {
            let decel_other = -force.dot(fwd_h) / mass * along.signum();
            let rto = ac.autobrake == 3 && idle_levers && along > 36.0;
            ac.autobrake_on = (ac.autobrake_on || ground_spoilers || rto) && along > 1.0;
            if ac.autobrake_on {
                let want = AUTOBRAKE[(ac.autobrake - 1) as usize];
                brake = brake.max((want - decel_other).clamp(0.0, grip));
            }
        }
        if ac.brakes > 0.5 {
            ac.autobrake_on = false;
        }
        let resist = 0.015 * normal / mass + brake;
        let a_along = force.dot(fwd_h) / mass;
        along += a_along * dt;
        let slow = resist * dt;
        along = if along.abs() <= slow && a_along.abs() <= resist { 0.0 } else if along.abs() <= slow { along } else { along - slow * along.signum() };
        // Tyres: sideways they grip up to µ of the load, so a crosswind pushes a light, fast aircraft sideways.
        let side_force = force.dot(right_h);
        let hold = (-lateral / dt * mass - side_force).clamp(-0.8 * normal, 0.8 * normal);
        lateral += (side_force + hold) / mass * dt;
        let vy = (velocity.y + force.y / mass * dt).max(0.0);
        *velocity = fwd_h * along + right_h * lateral + Vec3::Y * vy;

        // Steering: the nose wheel (tiller at taxi speeds, the pedals a little at any) turns it about the main gear;
        // at speed the rudder does, and the fin turns it into the wind.
        let slow_share = 1.0 - (along.abs() / 15.0).clamp(0.0, 1.0);
        let wheel = (input.tiller * ty.tiller * slow_share + input.yaw * ty.pedal_steer).clamp(-ty.tiller, ty.tiller);
        let r_wheel = along * wheel.tan() / ty.wheelbase;
        let r_aero = (input.yaw * ty.yaw_rate * 1.5 - 1.2 * beta) * authority;
        let r = r_wheel * wow + r_aero * (1.0 - 0.6 * wow);
        // Pitch: the elevator lifts the nose once the air over it is fast enough to beat the weight on the nose
        // wheel; let go, the nose comes back down as long as the wings do not carry the aircraft.
        let vr = ty.vspeeds(mass, 0.0).vr / KT;
        let effect = ((ac.eas - 0.82 * vr) / (0.18 * vr)).clamp(0.0, 1.0);
        let rate = if ty.law == Law::Direct { 0.18 } else { 0.055 };
        let pr = if input.pitch > 0.05 {
            input.pitch * rate * effect - 0.03 * (1.0 - effect)
        } else {
            -(pitch - ty.ground_pitch).max(0.0) * 0.8 * wow.max(0.2) + input.pitch * 0.02
        };
        let new_pitch = (pitch + pr * dt).clamp(ty.ground_pitch, ty.tail_strike + 0.03);
        if new_pitch > ty.tail_strike && !ac.tail_strike {
            ac.tail_strike = true;
            ac.events.push(Event::TailStrike);
        }
        tf.rotation = Quat::from_euler(EulerRot::YXZ, yaw + r * dt, new_pitch, 0.0);
        *omega = Vec3::new(pr, r, 0.0);
        tf.translation += *velocity * dt;
        let settled = env.ground - env.bottom;
        if vy <= 0.0 {
            tf.translation.y = settled;
        }
        if tf.translation.y > settled + 0.4 && vy > 0.3 {
            ac.on_ground = false;
            ac.rolling = 0.0;
            ac.autobrake_on = false;
            ac.events.push(Event::Liftoff);
        }
        return AirData { alpha, beta, g: ac.nz.max(1.0 - vy), mach, stalled: false, surfaces };
    }

    // In the air.
    *velocity += force / mass * dt;
    tf.translation += *velocity * dt;
    let v = speed.max(1.0);
    let (q_cmd, r_cmd, p_cmd) = match ty.law {
        Law::FlyByWire => {
            // Normal law: the stick asks for pitch rate and load factor, centred it holds the flight path (a load
            // factor of cos γ / cos φ); protections keep the angle of attack short of the stall and the bank within
            // 67° (back to 33° when let go).
            let hold = if speed > 5.0 && bank.cos() > 0.34 {
                let gamma = vhat.y.clamp(-1.0, 1.0).asin();
                let n_target = (gamma.cos() / bank.cos()).min(ty.g_max);
                ((n_target - ac.nz) * 0.8 * G / v).clamp(-ty.pitch_rate, ty.pitch_rate)
            } else {
                0.0
            };
            let q_up = ty.pitch_rate.min(ty.g_max * G / v);
            let q_down = ty.pitch_rate.min(-ty.g_min * G / v);
            let mut q_cmd = if input.pitch >= 0.0 { input.pitch * q_up } else { input.pitch * q_down } + (1.0 - input.pitch.abs()) * hold;
            let alpha_max = alpha_stall - 0.035;
            if alpha > alpha_max || ac.nz > ty.g_max {
                q_cmd = q_cmd.min(-(alpha - alpha_max).max(0.0) * 4.0);
            }
            if ac.nz < ty.g_min {
                q_cmd = q_cmd.max(0.0);
            }
            let mut p_cmd = -input.roll * ty.roll_rate;
            if input.roll.abs() < 0.05 && bank.abs() > 0.576 {
                p_cmd = (bank.abs() - 0.576) * bank.signum() * 0.5;
            }
            if bank.abs() > 1.17 && input.roll * bank > 0.0 {
                p_cmd = 0.0;
            }
            (q_cmd, input.yaw * ty.yaw_rate - 2.5 * beta, p_cmd)
        }
        Law::Direct => {
            // Cables: the elevator changes the angle of attack the aircraft settles at (the trim's, hands off), so it
            // flies at the speed it is trimmed for; past the stall the nose drops and a wing goes.
            let stability = (ac.trim + input.pitch * 0.2 - alpha) * 2.2 * authority;
            let mut q_cmd = input.pitch * ty.pitch_rate * authority * 0.6 + stability;
            let mut p_cmd = -input.roll * ty.roll_rate * authority;
            if stalled {
                q_cmd -= (alpha - alpha_stall) * 3.0;
                p_cmd += (alpha - alpha_stall) * 2.0 * if beta >= 0.0 { 1.0 } else { -1.0 };
            }
            // The propeller's slipstream and torque yaw a single left at high power and low speed.
            let p_factor = if let Engine::Prop { .. } = ty.engine { -0.04 * ac.lever * (1.0 - speed / 60.0).clamp(0.0, 1.0) } else { 0.0 };
            (q_cmd, input.yaw * ty.yaw_rate * authority - 2.0 * beta + p_factor, p_cmd)
        }
    };
    let target = Vec3::new(q_cmd, r_cmd, p_cmd) * if ty.law == Law::FlyByWire { authority } else { 1.0 };
    // With little air over the wings the nose weathervanes into the airflow.
    let slack = (1.0 - authority) * (1.0 - authority);
    let weathervane = Vec3::new(-(alpha - 0.05), beta, 0.0) * slack * 1.5;
    *omega += (target + weathervane - *omega) * (dt / ty.tau).min(1.0);
    tf.rotation = (tf.rotation * Quat::from_scaled_axis(*omega * dt)).normalize();

    // Contact: touchdown on the gear, or a crash.
    if tf.translation.y + env.bottom <= env.ground {
        let sink = -velocity.y;
        let track = velocity.with_y(0.0);
        let crab = if track.length() > 5.0 { (fwd.with_y(0.0).normalize_or_zero().cross(track.normalize()).y).asin() } else { 0.0 };
        let crash = if ac.gear < 0.99 {
            Some("GEAR UP LANDING")
        } else if sink > 5.2 {
            Some("HARD LANDING")
        } else if bank.abs() > 0.2 {
            Some("WING STRIKE")
        } else if pitch < -0.1 {
            Some("NOSE GEAR COLLAPSE")
        } else {
            None
        };
        if let Some(c) = crash {
            ac.events.push(Event::Crash(c));
        } else {
            ac.events.push(Event::Touchdown { sink, bank, pitch, crab, ias: ac.eas * KT });
            ac.on_ground = true;
            ac.rolling = 0.0;
            tf.translation.y = env.ground - env.bottom;
            velocity.y = 0.0;
            let yaw = crate::sandbox::yaw_of(tf.rotation);
            tf.rotation = Quat::from_euler(EulerRot::YXZ, yaw, pitch.max(ty.ground_pitch), 0.0);
            if pitch > ty.tail_strike {
                ac.tail_strike = true;
                ac.events.push(Event::TailStrike);
            }
        }
    }
    AirData { alpha, beta, g: ac.nz, mach, stalled, surfaces }
}

#[cfg(test)]
mod tests {
    use super::super::types::{AIRLINER, C172};
    use super::*;

    fn calm(alt: f32, ground: f32) -> Env {
        Env { wind: Vec3::ZERO, alt, ground, bottom: 0.0 }
    }

    /// Take-off roll at full thrust, rotating at VR: returns (VR reached at m, liftoff at m, speed at liftoff kt).
    fn takeoff(ty: &'static Type, fuel: f32, payload: f32) -> (f32, f32, f32) {
        let mut ac = Aircraft::new(ty, fuel, payload, true);
        ac.lever = 1.0;
        ac.n1 = ac.idle() + 0.3;
        let (mut tf, mut v, mut w) = (Transform::default(), Vec3::ZERO, Vec3::ZERO);
        let vr = ty.vspeeds(ac.mass(), 0.0).vr;
        let mut at_vr = None;
        for _ in 0..20_000 {
            let ias = ac.eas * KT;
            let input = Input { pitch: if ias >= vr { 1.0 } else { 0.0 }, ..default() };
            if ias >= vr && at_vr.is_none() {
                at_vr = Some(-tf.translation.z);
            }
            step(&mut ac, &mut tf, &mut v, &mut w, input, calm(0.0, 0.0), 0.01);
            if !ac.on_ground {
                return (at_vr.unwrap_or(0.0), -tf.translation.z, ac.eas * KT);
            }
        }
        panic!("never lifted off");
    }

    #[test]
    fn glider_has_no_thrust_or_fuel_flow_at_any_throttle() {
        use super::super::types::GLIDER;
        let mut ac = Aircraft::new(&GLIDER, 0.0, 90.0, false);
        for lever in [0.0, 0.5, 1.0] {
            ac.lever = lever;
            assert_eq!(engines(&mut ac, 30.0, 1200.0, 0.09, 0.1), 0.0);
            assert_eq!(ac.ff, 0.0);
            assert_eq!(ac.n1, 0.0);
        }
        assert!((30.0..45.0).contains(&GLIDER.vs1g(350.0, 0)));
    }

    #[test]
    fn airliner_takes_off_in_a_realistic_distance() {
        // 64 t: 42.6 t empty, 13 t of fuel, 8.4 t of payload.
        let (vr_at, off_at, v_lof) = takeoff(&AIRLINER, 13_000.0, 8_400.0);
        assert!((650.0..1_400.0).contains(&vr_at), "VR at {vr_at} m");
        assert!((800.0..1_900.0).contains(&off_at), "liftoff at {off_at} m");
        assert!((135.0..160.0).contains(&v_lof), "liftoff at {v_lof} kt");
    }

    #[test]
    fn light_single_takes_off_short() {
        let (_, off_at, v_lof) = takeoff(&C172, 120.0, 250.0);
        assert!((200.0..500.0).contains(&off_at), "liftoff at {off_at} m");
        assert!((50.0..70.0).contains(&v_lof), "liftoff at {v_lof} kt");
    }

    #[test]
    fn stall_speeds() {
        let m = 64_000.0;
        assert!((AIRLINER.vs1g(m, 0) - 145.0).abs() < 6.0);
        assert!((AIRLINER.vs1g(m, 5) - 113.0).abs() < 5.0);
        let vs = C172.vspeeds(1_111.0, 0.0);
        assert!((46.0..53.0).contains(&vs.vs_clean), "{}", vs.vs_clean);
    }

    /// Settles the airliner in level flight at a speed and altitude, with the thrust that holds it; returns the
    /// thrust lever and fuel flow.
    fn cruise(tas: f32, alt: f32) -> (f32, f32) {
        let mut ac = Aircraft::new(&AIRLINER, 10_000.0, 10_000.0, false);
        ac.n1 = 0.8;
        ac.lever = 0.7;
        let (mut tf, mut v, mut w) = (Transform::from_xyz(0.0, alt, 0.0), Vec3::NEG_Z * tas, Vec3::ZERO);
        let mut integral = 0.7;
        for i in 0..60_000 {
            let speed_err = tas - v.length();
            integral = (integral + speed_err * 0.00002).clamp(0.0, 1.0);
            ac.lever = (integral + speed_err * 0.05).clamp(0.0, 1.0);
            let climb = v.y;
            let input = Input { pitch: (-climb * 0.05 - (tf.translation.y - alt) * 0.002).clamp(-0.3, 0.3), ..default() };
            let env = calm(tf.translation.y, -1e6);
            step(&mut ac, &mut tf, &mut v, &mut w, input, env, 0.01);
            if i > 40_000 && speed_err.abs() > 3.0 {
                panic!("speed not held: {} (lever {}, alt {})", v.length(), ac.lever, tf.translation.y);
            }
        }
        (ac.lever, ac.ff)
    }

    #[test]
    fn airliner_cruises_on_realistic_fuel() {
        // M0.78 at FL350.
        let (lever, ff) = cruise(231.0, 10_668.0);
        assert!(lever < 0.98, "lever {lever}");
        let per_hour = ff * 3_600.0;
        assert!((1_900.0..3_100.0).contains(&per_hour), "{per_hour} kg/h");
    }

    #[test]
    fn light_single_climbs_as_the_book_says() {
        // Full power at 74 KIAS (best rate of climb), near maximum mass, sea level: about 730 ft/min.
        let mut ac = Aircraft::new(&C172, 120.0, 250.0, false);
        ac.lever = 1.0;
        ac.n1 = 0.95;
        let (mut tf, mut v, mut w) = (Transform::from_xyz(0.0, 100.0, 0.0), Vec3::NEG_Z * 38.0, Vec3::ZERO);
        let mut vs = 0.0;
        for i in 0..6_000 {
            let err = ac.eas * KT - 74.0;
            let input = Input { pitch: (err * 0.04).clamp(-0.5, 0.5), ..default() };
            let env = calm(tf.translation.y, -1e6);
            step(&mut ac, &mut tf, &mut v, &mut w, input, env, 0.01);
            if i > 4_000 {
                vs = v.y * 196.85;
            }
        }
        assert!((600.0..820.0).contains(&vs), "{vs} ft/min at {} KIAS", ac.eas * KT);
    }

    #[test]
    fn light_single_flies_hands_off_at_its_trim_speed() {
        let mut ac = Aircraft::new(&C172, 100.0, 200.0, false);
        ac.lever = 0.75;
        ac.n1 = 0.85;
        ac.flap_lever = 0;
        ac.flap = 0.0;
        let (mut tf, mut v, mut w) = (Transform::from_xyz(0.0, 1_500.0, 0.0), Vec3::NEG_Z * 50.0, Vec3::ZERO);
        let mut speeds = Vec::new();
        for i in 0..12_000 {
            let env = calm(tf.translation.y, -1e6);
            let air = step(&mut ac, &mut tf, &mut v, &mut w, Input::default(), env, 0.01);
            assert!(!air.stalled, "stalled after {} s", i as f32 / 100.0);
            if i > 9_000 {
                speeds.push(ac.eas * KT);
            }
        }
        // Settled: a steady speed (the phugoid damped out), wings level.
        let (lo, hi) = speeds.iter().fold((f32::MAX, f32::MIN), |(a, b), s| (a.min(*s), b.max(*s)));
        assert!((70.0..130.0).contains(&lo) && hi - lo < 12.0, "{lo}..{hi} kt");
        let (_, bank) = attitude(tf.rotation);
        assert!(bank.abs() < 0.1, "bank {bank}");
    }

    #[test]
    fn autobrake_holds_its_deceleration() {
        let mut ac = Aircraft::new(&AIRLINER, 5_000.0, 10_000.0, true);
        ac.autobrake = 2;
        ac.spoilers_armed = true;
        ac.flap_lever = 5;
        ac.flap = 5.0;
        ac.rolling = 1.0;
        let (mut tf, mut v, mut w) = (Transform::default(), Vec3::NEG_Z * 65.0, Vec3::ZERO);
        for _ in 0..300 {
            step(&mut ac, &mut tf, &mut v, &mut w, Input::default(), calm(0.0, 0.0), 0.01);
        }
        let v0 = v.length();
        for _ in 0..200 {
            step(&mut ac, &mut tf, &mut v, &mut w, Input::default(), calm(0.0, 0.0), 0.01);
        }
        let decel = (v0 - v.length()) / 2.0;
        assert!((decel - 3.0).abs() < 0.45, "{decel} m/s²");
        assert!(ac.on_ground);
    }

    #[test]
    fn crosswind_rollout_holds_the_centreline_with_rudder() {
        let mut ac = Aircraft::new(&AIRLINER, 5_000.0, 10_000.0, true);
        ac.autobrake = 1;
        ac.spoilers_armed = true;
        ac.rolling = 1.0;
        ac.flap_lever = 5;
        ac.flap = 5.0;
        let (mut tf, mut v, mut w) = (Transform::default(), Vec3::NEG_Z * 65.0, Vec3::ZERO);
        // 15 kt from the right.
        let env = Env { wind: Vec3::new(-7.7, 0.0, 0.0), ..calm(0.0, 0.0) };
        for _ in 0..4_000 {
            let yaw = crate::sandbox::yaw_of(tf.rotation);
            let input = Input { yaw: (-yaw * 8.0 + tf.translation.x * 0.3).clamp(-1.0, 1.0), ..default() };
            step(&mut ac, &mut tf, &mut v, &mut w, input, env, 0.01);
        }
        assert!(tf.translation.x.abs() < 5.0, "drifted {} m", tf.translation.x);
        assert!(v.length() < 20.0);
    }
}
