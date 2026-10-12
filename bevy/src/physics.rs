//! Vehicle dynamics for the sandbox: a fixed-wing flight model (the F-35A and both drones), a helicopter and a
//! tracked vehicle. Forces are physical (lift, drag, thrust, rotor thrust, traction, gravity, air density with
//! height); the rotations go through a fly-by-wire layer, as the real aircraft's do, so the controls command rates
//! and attitudes rather than raw surfaces.
//!
//! Frames: Bevy's, with a vehicle's forward along its local −Z, up +Y, right +X. World up is +Y (the floating origin
//! keeps the local vertical within a fraction of a degree of it).

use bevy::prelude::*;

pub const G: f32 = 9.81;
const RHO0: f32 = 1.225;

/// ISA air density (kg/m³) and speed of sound (m/s) at a height above mean sea level (m).
pub fn atmosphere(h: f32) -> (f32, f32) {
    let h = h.clamp(-500.0, 20_000.0);
    let (t, rho) = if h < 11_000.0 {
        (288.15 - 0.0065 * h, RHO0 * (1.0 - 2.255_77e-5 * h).powf(4.2559))
    } else {
        (216.65, 0.3639 * (-(h - 11_000.0) / 6341.6).exp())
    };
    (rho, 20.046 * t.sqrt())
}

/// A fixed-wing airframe.
#[derive(Clone, Copy)]
pub struct Airframe {
    pub mass: f32,
    pub wing_area: f32,
    /// Lift slope (per rad), maximum lift coefficient and the angle of attack where it stalls (rad).
    pub cl_alpha: f32,
    pub cl_max: f32,
    pub alpha_stall: f32,
    pub cd0: f32,
    /// Induced drag factor k in CD = CD0 + k·CL².
    pub k: f32,
    /// Side force per rad of sideslip.
    pub cy_beta: f32,
    /// Thrust at sea level (N): dry, and with afterburner (0 without one).
    pub thrust: f32,
    pub thrust_ab: f32,
    /// Fly-by-wire limits: load factors, body rates (rad/s), the angle-of-attack limiter (rad).
    pub g_max: f32,
    pub g_min: f32,
    pub pitch_rate: f32,
    pub roll_rate: f32,
    pub yaw_rate: f32,
    pub alpha_max: f32,
    /// Dynamic pressure (Pa) from which the control surfaces have full authority.
    pub q_full: f32,
    /// How quickly the body rates follow the commands (s).
    pub tau: f32,
    /// Extra drag coefficient of the lowered gear; zero for an aircraft without one.
    pub cd_gear: f32,
    /// Extra drag coefficient with the speed brake out; zero for an aircraft without one.
    pub cd_brake: f32,
    /// Supersonic: whether the transonic drag rise applies (drones never get there).
    pub transonic: bool,
}








/// An airframe between two (a swing wing between spread, `t` 0, and swept, `t` 1): every figure interpolated.
pub fn blend(a: &Airframe, b: &Airframe, t: f32) -> Airframe {
    let l = |x: f32, y: f32| x + (y - x) * t.clamp(0.0, 1.0);
    Airframe {
        mass: l(a.mass, b.mass),
        wing_area: l(a.wing_area, b.wing_area),
        cl_alpha: l(a.cl_alpha, b.cl_alpha),
        cl_max: l(a.cl_max, b.cl_max),
        alpha_stall: l(a.alpha_stall, b.alpha_stall),
        cd0: l(a.cd0, b.cd0),
        k: l(a.k, b.k),
        cy_beta: l(a.cy_beta, b.cy_beta),
        thrust: l(a.thrust, b.thrust),
        thrust_ab: l(a.thrust_ab, b.thrust_ab),
        g_max: l(a.g_max, b.g_max),
        g_min: l(a.g_min, b.g_min),
        pitch_rate: l(a.pitch_rate, b.pitch_rate),
        roll_rate: l(a.roll_rate, b.roll_rate),
        yaw_rate: l(a.yaw_rate, b.yaw_rate),
        alpha_max: l(a.alpha_max, b.alpha_max),
        q_full: l(a.q_full, b.q_full),
        tau: l(a.tau, b.tau),
        cd_gear: l(a.cd_gear, b.cd_gear),
        cd_brake: l(a.cd_brake, b.cd_brake),
        transonic: a.transonic || b.transonic,
    }
}



/// Narrow-body airliner (A320 class), clean wing.
pub const AIRLINER: Airframe = Airframe {
    mass: 64_000.0,
    wing_area: 122.6,
    cl_alpha: 5.5,
    cl_max: 1.6,
    alpha_stall: 0.27,
    cd0: 0.022,
    k: 0.045,
    cy_beta: 1.0,
    thrust: 240_000.0,
    thrust_ab: 0.0,
    g_max: 2.5,
    g_min: -1.0,
    pitch_rate: 0.12,
    roll_rate: 0.35,
    yaw_rate: 0.08,
    alpha_max: 0.25,
    q_full: 4_000.0,
    tau: 0.6,
    cd_gear: 0.02,
    cd_brake: 0.0,
    transonic: true,
};


/// C172-class light single (fixed gear: its drag is in CD0), for the sandbox; a flight flies it with cables and a
/// propeller (`sandbox/flight/types.rs`).
pub const C172: Airframe = Airframe {
    mass: 1_100.0,
    wing_area: 16.2,
    cl_alpha: 4.9,
    cl_max: 1.6,
    alpha_stall: 0.27,
    cd0: 0.036,
    k: 0.054,
    cy_beta: 1.2,
    thrust: 2_700.0,
    thrust_ab: 0.0,
    g_max: 3.8,
    g_min: -1.5,
    pitch_rate: 0.5,
    roll_rate: 1.2,
    yaw_rate: 0.5,
    alpha_max: 0.25,
    q_full: 500.0,
    tau: 0.25,
    cd_gear: 0.0,
    cd_brake: 0.0,
    transonic: false,
};

/// Pilot input, each −1..1 (the throttle 0..1). Pitch up, roll right and yaw left are positive.
#[derive(Default, Clone, Copy)]
pub struct Stick {
    pub pitch: f32,
    pub roll: f32,
    pub yaw: f32,
    pub throttle: f32,
    /// Hold the flight path when the stick is centred (the fly-by-wire's normal law).
    pub path_hold: bool,
    /// Speed brake, 0 in .. 1 out.
    pub speedbrake: f32,
}

/// Where the flight-control surfaces are, as commands: pitch, roll and yaw −1..1 (the stick's senses: nose up, roll
/// right, yaw left), flap, leading-edge droop and airbrake 0..1. The model's control nodes show them.
#[derive(Default, Clone, Copy)]
pub struct Surfaces {
    pub pitch: f32,
    pub roll: f32,
    pub yaw: f32,
    pub flap: f32,
    pub droop: f32,
    pub brake: f32,
}

impl Surfaces {
    /// Moved toward `to` at the actuators' rates (full travel per second, `dt` s).
    pub fn toward(self, to: Surfaces, dt: f32) -> Surfaces {
        let step = |a: f32, b: f32, rate: f32| a + (b - a).clamp(-rate * dt, rate * dt);
        Surfaces {
            pitch: step(self.pitch, to.pitch, 4.0),
            roll: step(self.roll, to.roll, 4.0),
            yaw: step(self.yaw, to.yaw, 4.0),
            flap: step(self.flap, to.flap, 0.5),
            droop: step(self.droop, to.droop, 1.5),
            brake: step(self.brake, to.brake, 1.2),
        }
    }
    pub fn to_array(self) -> [f32; 6] {
        [self.pitch, self.roll, self.yaw, self.flap, self.droop, self.brake]
    }
    pub fn from_array(a: [f32; 6]) -> Surfaces {
        Surfaces { pitch: a[0], roll: a[1], yaw: a[2], flap: a[3], droop: a[4], brake: a[5] }
    }
}

/// What the flight model hands back to the HUD.
#[derive(Default, Clone, Copy)]
pub struct AirData {
    pub alpha: f32,
    pub beta: f32,
    pub g: f32,
    pub mach: f32,
    pub stalled: bool,
    /// What the fly-by-wire asks of the control surfaces.
    pub surfaces: Surfaces,
}

/// Pitch (nose above the horizon) and bank (right wing down positive) of an orientation, rad.
pub fn attitude(rot: Quat) -> (f32, f32) {
    let fwd = rot * Vec3::NEG_Z;
    let right = rot * Vec3::X;
    let up = rot * Vec3::Y;
    (fwd.y.clamp(-1.0, 1.0).asin(), (-right.y).atan2(up.y))
}

fn lift_coefficient(af: &Airframe, alpha: f32) -> f32 {
    let a = alpha.abs();
    let cl = if a <= af.alpha_stall {
        af.cl_alpha * a
    } else {
        // Past the stall the lift falls away toward that of a flat plate.
        let past = ((a - af.alpha_stall) / 0.35).min(1.0);
        let plate = (2.0 * a).sin() * 0.9;
        af.cl_max * (1.0 - past) + plate * past
    };
    cl.min(af.cl_max) * alpha.signum()
}

/// One step of the fixed-wing model: forces in the world frame, rates through the fly-by-wire.
/// `wind` is the air's own velocity (m/s): the aerodynamics see the velocity through the air, not over the ground.
#[allow(clippy::too_many_arguments)]
pub fn step_airframe(af: &Airframe, tf: &mut Transform, velocity: &mut Vec3, omega: &mut Vec3, stick: Stick, gear_down: bool, alt_msl: f32, wind: Vec3, dt: f32) -> AirData {
    let rot = tf.rotation;
    let (fwd, up, right) = (rot * Vec3::NEG_Z, rot * Vec3::Y, rot * Vec3::X);
    let air = *velocity - wind;
    let speed = air.length();
    let (rho, sound) = atmosphere(alt_msl);
    let q = 0.5 * rho * speed * speed;
    let body = rot.inverse() * air;
    let (alpha, beta) = if speed > 1.0 { ((-body.y).atan2((-body.z).max(0.1)), (body.x / speed).clamp(-1.0, 1.0).asin()) } else { (0.0, 0.0) };
    let cl = lift_coefficient(af, alpha);
    let mach = speed / sound;
    let wave = if af.transonic { 0.035 * ((mach - 0.85) / 0.25).clamp(0.0, 1.0) - 0.012 * ((mach - 1.2) / 0.6).clamp(0.0, 1.0) } else { 0.0 };
    let cd = af.cd0 + af.k * cl * cl + wave + if gear_down { af.cd_gear } else { 0.0 } + af.cd_brake * stick.speedbrake + 1.2 * alpha.sin().powi(2);
    let vhat = air.normalize_or_zero();
    let lift = right.cross(vhat).normalize_or_zero() * q * af.wing_area * cl;
    let drag = -vhat * q * af.wing_area * cd;
    let side = -right * q * af.wing_area * af.cy_beta * beta;
    let density_ratio = (rho / RHO0).powf(0.7);
    let thrust = if af.thrust_ab > 0.0 {
        let dry = af.thrust * (stick.throttle / 0.9).min(1.0);
        let ab = if stick.throttle > 0.9 { (af.thrust_ab - af.thrust) * (stick.throttle - 0.9) / 0.1 } else { 0.0 };
        dry + ab
    } else {
        af.thrust * stick.throttle
    } * density_ratio;
    let aero = lift + drag + side + fwd * thrust;
    *velocity += (aero / af.mass + Vec3::NEG_Y * G) * dt;
    tf.translation += *velocity * dt;

    // Fly-by-wire: stick → body rates, bounded by the g and angle-of-attack limits and by what the air allows.
    let authority = (q / af.q_full).clamp(0.03, 1.0);
    let v = speed.max(1.0);
    let (_, bank) = attitude(rot);
    let g_now = aero.dot(up) / (af.mass * G);
    // Centred stick: the normal law holds the flight path — a load factor of cos γ / cos φ, which is 1 g level and
    // a level, coordinated turn in a bank (no hold past 70° of bank or inverted).
    let hold = if stick.path_hold && speed > 5.0 && bank.cos() > 0.34 {
        let gamma = vhat.y.clamp(-1.0, 1.0).asin();
        let n_target = (gamma.cos() / bank.cos()).min(af.g_max);
        ((n_target - g_now) * 0.8 * G / v).clamp(-af.pitch_rate, af.pitch_rate)
    } else {
        0.0
    };
    let q_up = af.pitch_rate.min(af.g_max * G / v);
    let q_down = af.pitch_rate.min(-af.g_min * G / v);
    let mut q_cmd = if stick.pitch >= 0.0 { stick.pitch * q_up } else { stick.pitch * q_down } + (1.0 - stick.pitch.abs()) * hold;
    if alpha > af.alpha_max || g_now > af.g_max {
        q_cmd = q_cmd.min(-(alpha - af.alpha_max).max(0.0) * 4.0);
    }
    if alpha < -af.alpha_max * 0.6 || g_now < af.g_min {
        q_cmd = q_cmd.max(0.0);
    }
    let r_cmd = stick.yaw * af.yaw_rate - 2.5 * beta;
    let p_cmd = -stick.roll * af.roll_rate;
    let target = Vec3::new(q_cmd, r_cmd, p_cmd) * authority;
    // The surfaces follow the commanded rates, plus a lead while the aircraft catches up with them (and the check
    // that stops it when the stick comes back).
    let err = target - *omega;
    let surfaces = Surfaces {
        pitch: ((q_cmd + 0.5 * err.x) / af.pitch_rate).clamp(-1.0, 1.0),
        roll: (-(p_cmd + 0.5 * err.z) / af.roll_rate).clamp(-1.0, 1.0),
        yaw: ((r_cmd + 0.5 * err.y) / af.yaw_rate).clamp(-1.0, 1.0),
        flap: if gear_down { 1.0 } else { 0.0 },
        droop: ((alpha - 0.06) / (af.alpha_max - 0.06)).clamp(0.0, 1.0),
        brake: stick.speedbrake,
    };
    // With little air over the wings the nose weathervanes into the airflow.
    let weathervane = Vec3::new(-alpha, beta, 0.0) * (1.0 - authority) * 1.5;
    *omega += (target + weathervane - *omega) * (dt / af.tau).min(1.0);
    tf.rotation = (tf.rotation * Quat::from_scaled_axis(*omega * dt)).normalize();
    AirData { alpha, beta, g: g_now, mach, stalled: alpha.abs() > af.alpha_stall, surfaces }
}

/// NH90-class utility helicopter.
pub struct Rotorcraft {
    pub mass: f32,
    /// Rotor thrust at full collective, sea level (N).
    pub thrust_max: f32,
    /// Climb speed (m/s) at which the rotor would need infinite power: the engines' power, not the rotor, limits the
    /// climb (thrust falls as the climb rate eats into it).
    pub power_climb: f32,
    /// Drag areas (m², Cd·A) along the body's forward, side and vertical axes.
    pub drag_area: Vec3,
    pub max_pitch: f32,
    pub max_bank: f32,
    pub yaw_rate: f32,
}

/// Full-collective thrust over the weight: a best climb of about 8 m/s, as the real NH90's.
pub const HOVER_MARGIN: f32 = 1.3;

pub const NH90: Rotorcraft = Rotorcraft {
    mass: 10_600.0,
    thrust_max: 10_600.0 * G * HOVER_MARGIN,
    power_climb: 35.0,
    // Cd·A: forward (gives its ~300 km/h at full forward cyclic), side, and vertical (rotor disc and fuselage).
    drag_area: Vec3::new(8.9, 25.0, 45.0),
    max_pitch: 0.35,
    max_bank: 0.45,
    yaw_rate: 1.2,
};

/// Stick for the helicopter: cyclic (forward and right positive), pedals (left positive), collective 0..1.
#[derive(Default, Clone, Copy)]
pub struct Cyclic {
    pub forward: f32,
    pub right: f32,
    pub pedal: f32,
    pub collective: f32,
}

/// One step of the helicopter: rotor thrust along the mast, drag per body axis, gravity. The stability
/// augmentation turns the cyclic into attitude commands and holds them.
#[allow(clippy::too_many_arguments)]
pub fn step_heli(rc: &Rotorcraft, tf: &mut Transform, velocity: &mut Vec3, omega: &mut Vec3, c: Cyclic, agl: f32, alt_msl: f32, wind: Vec3, dt: f32) -> f32 {
    let (rho, _) = atmosphere(alt_msl);
    let ground_effect = 1.0 + 0.12 * (1.0 - (agl / 12.0).clamp(0.0, 1.0));
    let climb = velocity.y.max(0.0);
    let thrust = c.collective * rc.thrust_max * (rho / RHO0) * ground_effect * (1.0 - climb / rc.power_climb).max(0.0);
    let up = tf.rotation * Vec3::Y;
    let body = tf.rotation.inverse() * (*velocity - wind);
    let area = Vec3::new(rc.drag_area.y, rc.drag_area.z, rc.drag_area.x);
    let drag_body = -0.5 * rho * body.abs() * body * area;
    let force = up * thrust + tf.rotation * drag_body + Vec3::NEG_Y * G * rc.mass;
    *velocity += force / rc.mass * dt;
    tf.translation += *velocity * dt;
    let (pitch, bank) = attitude(tf.rotation);
    let want_pitch = -c.forward * rc.max_pitch;
    let want_bank = c.right * rc.max_bank;
    let target = Vec3::new(((want_pitch - pitch) * 2.5).clamp(-0.8, 0.8), c.pedal * rc.yaw_rate, (-(want_bank - bank) * 2.5).clamp(-1.0, 1.0));
    *omega += (target - *omega) * (dt / 0.2).min(1.0);
    tf.rotation = (tf.rotation * Quat::from_scaled_axis(*omega * dt)).normalize();
    thrust / (rc.mass * G)
}

/// How a ground vehicle turns.
pub enum Steering {
    /// Tracks: a yaw rate at a standstill (rad/s), falling to half at full speed; it can pivot in place.
    Skid(f32),
    /// Steered wheels: the largest wheel angle (rad) and the wheelbase (m); it turns only when rolling.
    Wheels(f32, f32),
}

/// A land vehicle: tracked or wheeled.
pub struct Ground {
    pub mass: f32,
    pub power: f32,
    pub traction: f32,
    pub rolling: f32,
    pub max_forward: f32,
    pub max_reverse: f32,
    pub steering: Steering,
}


/// A gun turret's drives and elevation limits (rad/s, rad).
pub struct TurretDrive {
    pub traverse_rate: f32,
    pub elevation_rate: f32,
    pub gun_min: f32,
    pub gun_max: f32,
}


/// A displacement vessel, surface or submerged.
pub struct Vessel {
    pub mass: f32,
    /// Full-power propulsive thrust (N) and the speed it reaches (m/s): the hull's drag is quadratic between them.
    pub thrust: f32,
    pub max_speed: f32,
    /// Yaw rate (rad/s) at full rudder and full speed; it scales with the speed through the water.
    pub turn_rate: f32,
    /// Deepest it goes (m); 0 for a surface ship.
    pub max_depth: f32,
}


/// Speed through the water after one step: thrust against the hull's quadratic drag.
pub fn step_vessel(v: &Vessel, speed: f32, throttle: f32, dt: f32) -> f32 {
    let drag = v.thrust / (v.max_speed * v.max_speed);
    let force = throttle * v.thrust - drag * speed * speed.abs();
    (speed + force / v.mass * dt).clamp(-v.max_speed * 0.5, v.max_speed)
}

/// Forward speed after one step: the engine's power, capped by traction, against rolling resistance and the slope
/// (`grade`: the sine of the hull's pitch). Traction is the grip of the tracks or tyres on the slope: past about 40°
/// they spin and it rolls back, and stopped on the brakes it holds on any slope they grip on.
pub fn step_ground(t: &Ground, speed: f32, throttle: f32, braking: bool, grade: f32, dt: f32) -> f32 {
    let normal = (1.0 - grade * grade).max(0.0).sqrt();
    let traction = t.traction * t.mass * G * normal;
    let braked = braking || throttle.abs() < 0.01;
    if braked && speed.abs() < 0.3 && grade.abs() < t.traction * normal {
        return 0.0;
    }
    let drive = if throttle.abs() > 0.01 { throttle * (t.power / speed.abs().max(1.5)).min(traction) } else { 0.0 };
    let resist = t.rolling * t.mass * G * normal + if braked { 0.35 * t.mass * G * normal } else { 0.0 };
    let slope = -grade * t.mass * G;
    let mut v = speed + (drive + slope) / t.mass * dt;
    // Resistance only slows, never reverses.
    let slow = resist / t.mass * dt;
    v = if v.abs() <= slow { 0.0 } else { v - slow * v.signum() };
    v.clamp(-t.max_reverse, t.max_forward)
}

/// How fast a land vehicle slides sideways down a slope it stands across (m/s), at `bank` (rad): nothing until the
/// slope outgrows the grip of its tracks or tyres sideways (less than along them: about 35° for tracks).
pub fn side_slip(t: &Ground, bank: f32) -> f32 {
    const SLIDE: f32 = 4.0;
    let grip = t.traction * 0.8;
    SLIDE * (bank.abs().sin() - grip * bank.cos()).max(0.0)
}

/// Superelevation (rad) for a round at `muzzle` m/s to drop onto a target `range` m away.
pub fn superelevation(range: f32, muzzle: f32) -> f32 {
    0.5 * (G * range / (muzzle * muzzle)).clamp(-1.0, 1.0).asin()
}


/// Unpowered 15 m sailplane used for local airborne exploration.
pub const GLIDER: Airframe = Airframe {
 mass: 350.0, wing_area: 10.5, cl_alpha: 5.7, cl_max: 1.5,
 cd0: 0.009, k: 0.019, thrust: 0.0, cd_gear: 0.012, cd_brake: 0.12,
 roll_rate: 0.85, g_max: 5.3, g_min: -2.65, ..C172
};
