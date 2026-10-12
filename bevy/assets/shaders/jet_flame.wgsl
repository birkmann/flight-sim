// Jet exhaust (src/sandbox/exhaust.rs): the plume and afterburner flame behind a nozzle, marched through as a glowing
// volume. The mesh is a hull cylinder on the nozzle exit, local +X downstream; everything here is in nozzle radii.
#import bevy_pbr::mesh_functions::{get_world_from_local, get_local_from_world, mesh_position_local_to_clip}
#import bevy_pbr::mesh_view_bindings::{view, globals}
#ifdef TONEMAP_IN_SHADER
#import bevy_core_pipeline::tonemapping::tone_mapping
#endif

struct Flame {
    // Nozzle radius (m), the hull's length and radius (nozzle radii), a random phase.
    shape: vec4<f32>,
    // Engine power over the dry range, afterburner (both 0..1), unused, unused.
    power: vec4<f32>,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> flame: Flame;

const STEPS: i32 = 32;

struct Vertex {
    @builtin(instance_index) instance_index: u32,
    @location(0) position: vec3<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    // The point on the hull and the camera, in the nozzle's frame.
    @location(0) local: vec3<f32>,
    @location(1) eye: vec3<f32>,
};

@vertex
fn vertex(v: Vertex) -> VertexOutput {
    var out: VertexOutput;
    out.clip = mesh_position_local_to_clip(get_world_from_local(v.instance_index), vec4<f32>(v.position, 1.0));
    let r = flame.shape.x;
    out.local = v.position / r;
    out.eye = (get_local_from_world(v.instance_index) * vec4<f32>(view.world_position, 1.0)).xyz / r;
    return out;
}

fn hash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.zyx + 31.32);
    return fract((q.x + q.y) * q.z);
}

fn noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(
        mix(mix(hash(i), hash(i + vec3<f32>(1.0, 0.0, 0.0)), u.x), mix(hash(i + vec3<f32>(0.0, 1.0, 0.0)), hash(i + vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
        mix(mix(hash(i + vec3<f32>(0.0, 0.0, 1.0)), hash(i + vec3<f32>(1.0, 0.0, 1.0)), u.x), mix(hash(i + vec3<f32>(0.0, 1.0, 1.0)), hash(i + vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y),
        u.z,
    );
}

// Turbulence 0..1: eddies, and smaller ones in them.
fn fbm(p: vec3<f32>) -> f32 {
    return 0.55 * noise(p) + 0.3 * noise(p * 2.03 + vec3<f32>(7.1, 3.3, 1.7)) + 0.15 * noise(p * 4.07 + vec3<f32>(2.9, 8.4, 5.2));
}

// What the gas at p gives off (rgb, per nozzle radius of path) and how much it dims the view through it (a).
fn gas(p: vec3<f32>, time: f32) -> vec4<f32> {
    let dry = flame.power.x;
    let ab = flame.power.y;
    let u = p.x;
    let q = length(p.yz);
    // Eddies carried downstream with the gas, drawn out into streaks along the flow.
    let flow = time * (9.0 + 16.0 * ab);
    let n = fbm(vec3<f32>(u * 0.35 - flow, p.y * 2.2, p.z * 2.2) + flame.shape.w);
    var light = vec3<f32>(0.0);
    var dim = 0.0;

    if (ab > 0.001) {
        // The flame: the exit's width for the first diameters, then closing to a ragged point.
        let len = mix(4.0, 8.5, ab) * (0.85 + 0.3 * n);
        let along = u / len;
        let width = 0.88 * sqrt(max(1.0 - pow(min(along, 1.0), 2.2), 0.0)) * (0.9 + 0.2 * n);
        let body = smoothstep(width, width * 0.4, q);
        // A ragged fringe of burning gas mixing into the air around it.
        let fringe = smoothstep(width * (1.1 + 0.6 * n), width, q) * (1.0 - body) * smoothstep(1.1, 0.3, along);
        // Shock diamonds: standing cells about a diameter apart, bright where the jet is compressed on the axis, fading
        // as it slows.
        let cell = 1.9 - 0.2 * along;
        let ph = fract(u / cell + 0.2);
        let diamond_w = 0.62 * (1.0 - abs(ph * 2.0 - 1.0));
        let diamond = smoothstep(diamond_w, diamond_w * 0.35, q);
        let disc = exp(-pow((ph - 0.5) * 8.0, 2.0)) * smoothstep(0.5, 0.05, q);
        let shock = max(diamond * 0.55, disc) * exp(-u / (1.6 + 2.2 * ab)) * smoothstep(0.15, 0.7, u);
        // Blue-violet at the lip, yellow then orange as it burns, red where it mixes out.
        var c = mix(vec3<f32>(1.0, 0.6, 0.22), vec3<f32>(1.0, 0.3, 0.05), smoothstep(0.1, 0.6, along));
        c = mix(c, vec3<f32>(0.7, 0.1, 0.02), smoothstep(0.55, 1.0, along));
        c = mix(c, vec3<f32>(0.4, 0.42, 1.0), 0.7 * exp(-u * 1.5));
        // The hot core: a yellow-white cone inside the flame, shorter than it.
        let core = smoothstep(width * 0.55, 0.0, q) * (1.0 - smoothstep(0.2, 0.65, along));
        let glow = c * (body * (0.6 + 0.5 * n) + fringe * 0.35 * n) + vec3<f32>(1.0, 0.72, 0.4) * core * 0.9;
        light += (glow * 0.9 + vec3<f32>(1.0, 0.85, 0.62) * shock * 5.0) * ab;
        dim += (body * 0.35 + fringe * 0.08) * ab;
    }

    if (dry > 0.001) {
        // Dry the gas is all but clear: a faint glow for a diameter or two, bluer on the axis at high power.
        let len = 1.5 + 2.5 * dry;
        let along = u / len;
        let width = 0.85 * (1.0 - smoothstep(0.2, 1.0, along)) * (0.85 + 0.3 * n);
        let body = smoothstep(width, width * 0.2, q) * (1.0 - smoothstep(0.5, 1.0, along));
        let c = mix(vec3<f32>(1.0, 0.42, 0.14), vec3<f32>(0.5, 0.55, 1.0), 0.5 * dry * exp(-u * 1.5));
        light += c * body * 0.12 * dry * dry * (0.6 + 0.8 * n) * (1.0 - ab);
    }
    return vec4<f32>(light, dim);
}

// The tailpipe seen through the exit: flameholder rings white-yellow in afterburner, a dull glow dry. rgb and cover.
fn tailpipe(q: f32) -> vec4<f32> {
    let dry = flame.power.x;
    let ab = flame.power.y;
    let rim = 1.0 - smoothstep(0.8, 0.96, q);
    let rings = 0.72 + 0.28 * cos(q * 21.0);
    let hot = vec3<f32>(1.0, 0.3, 0.07) * (0.05 + 0.3 * dry * dry) * (1.1 - 0.4 * q) * rings;
    // In afterburner: white-hot at the centre through yellow to deep orange at the liner, the rings standing out.
    let heat = 1.0 - smoothstep(0.0, 0.9, q);
    let burning = mix(vec3<f32>(1.0, 0.42, 0.1), vec3<f32>(1.0, 0.86, 0.62), heat) * (0.9 + 1.6 * heat) * (0.7 + 0.3 * rings);
    return vec4<f32>(mix(hot, burning, ab) * rim, rim * (0.45 + 0.3 * max(dry, ab)));
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let len = flame.shape.y;
    let rad = flame.shape.z;
    let eye = in.eye;
    let dir = normalize(in.local - eye);
    // Where the view ray is inside the hull: a cylinder about +X, from the exit (x = 0) to len.
    var t0 = -1e9;
    var t1 = 1e9;
    let a = dot(dir.yz, dir.yz);
    let b = dot(eye.yz, dir.yz);
    let c = dot(eye.yz, eye.yz) - rad * rad;
    if (a > 1e-8) {
        let h = b * b - a * c;
        if (h <= 0.0) {
            discard;
        }
        let s = sqrt(h);
        t0 = (-b - s) / a;
        t1 = (-b + s) / a;
    } else if (c > 0.0) {
        discard;
    }
    if (abs(dir.x) > 1e-8) {
        let ta = -eye.x / dir.x;
        let tb = (len - eye.x) / dir.x;
        t0 = max(t0, min(ta, tb));
        t1 = min(t1, max(ta, tb));
    } else if (eye.x < 0.0 || eye.x > len) {
        discard;
    }
    let inside = t0 < 0.0;
    t0 = max(t0, 0.0);
    if (t1 <= t0) {
        discard;
    }
    // Both faces are drawn; from outside only the near one marches.
    if (!inside && length(in.local - eye) > 0.5 * (t0 + t1)) {
        discard;
    }

    let time = globals.time;
    let dt = (t1 - t0) / f32(STEPS);
    // Start each pixel's steps a little apart, so the slices blend rather than band.
    let jitter = fract(52.9829189 * fract(dot(in.clip.xy, vec2<f32>(0.06711056, 0.00583715))));
    var t = t0 + dt * jitter;
    var light = vec3<f32>(0.0);
    var clear = 1.0;
    for (var i = 0; i < STEPS; i = i + 1) {
        let g = gas(eye + dir * t, time);
        light += clear * g.rgb * dt;
        clear *= exp(-g.a * dt);
        t += dt;
    }
    // Looking up the jet, the ray leaves through the exit into the tailpipe.
    let exit = eye + dir * t1;
    let q = length(exit.yz);
    if (dir.x < 0.0 && exit.x < 0.01 && q < 0.96) {
        let pipe = tailpipe(q);
        light += clear * pipe.rgb;
        clear *= 1.0 - pipe.a;
    }
    // The flame's own flicker, faster in afterburner.
    light *= 0.9 + 0.2 * noise(vec3<f32>(time * (14.0 + 20.0 * flame.power.y), flame.shape.w, 0.0));
    var color = vec4<f32>(light, 1.0 - clear);
    if (color.a < 0.002 && max(light.r, max(light.g, light.b)) < 0.002) {
        discard;
    }
#ifdef TONEMAP_IN_SHADER
    color = tone_mapping(color, view.color_grading);
#endif
    return color;
}
