// Rain and snow around the camera (src/weather/precip.rs). One mesh of quads, one per particle; the vertex shader
// places them. Each particle has a fixed spot in a box of air that drifts with the wind and falls, and the box wraps
// around the camera: flying through the air sweeps past the particles, and they streak by the camera's speed.
//
// Vertex attributes: position = the particle's spot in its box (0..1), normal = (shown below this amount, size, phase),
// uv = (corner x + 2 × layer, corner y). The three layers are nested boxes: dense and close, then sparser and further.
#import bevy_pbr::mesh_view_bindings::view
#ifdef TONEMAP_IN_SHADER
#import bevy_core_pipeline::tonemapping::tone_mapping
#endif

struct Precip {
    // Per layer: the air's drift (m, wrapped to the box) and the box's size (m).
    drift: array<vec4<f32>, 3>,
    // The particles' velocity relative to the camera (m/s), and the exposure a streak spans (s).
    motion: vec4<f32>,
    // Colour and opacity.
    color: vec4<f32>,
    // Amount 0..1, snow 0 or 1, time (s), unused.
    params: vec4<f32>,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> precip: Precip;

struct Vertex {
    @location(0) spot: vec3<f32>,
    @location(1) rnd: vec3<f32>,
    @location(2) corner: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clip: vec4<f32>,
    // Across and along the streak in radii, and the streak's length in radii.
    @location(0) local: vec3<f32>,
    // Opacity and edge softness.
    @location(1) look: vec2<f32>,
};

fn hidden() -> VertexOutput {
    var out: VertexOutput;
    out.clip = vec4<f32>(0.0, 0.0, -1.0, 1.0);
    out.local = vec3<f32>(9.0, 9.0, 0.0);
    out.look = vec2<f32>(0.0, 1.0);
    return out;
}

@vertex
fn vertex(v: Vertex) -> VertexOutput {
    let amount = precip.params.x;
    let snow = precip.params.y > 0.5;
    let t = precip.params.z;
    if (v.rnd.x >= amount) {
        return hidden();
    }
    let layer = u32(floor(v.corner.x * 0.5));
    let corner = vec2<f32>(v.corner.x - 2.0 * f32(layer), v.corner.y);
    let drift = precip.drift[layer];
    let size = drift.w;
    let cam = view.world_position;
    // The spot, wrapped into the box around the camera.
    let rel = (fract((v.spot * size + drift.xyz - cam) / size) - 0.5) * size;
    var center = cam + rel;
    var velocity = precip.motion.xyz;
    var radius: f32;
    if (snow) {
        // Flakes flutter as they fall.
        let w = 0.9 + 0.8 * v.rnd.z;
        let ph = v.rnd.z * 40.0;
        let a = 0.25 + 0.35 * v.rnd.y;
        center += vec3<f32>(sin(t * w + ph), 0.0, cos(t * w * 0.77 + ph * 1.3)) * a;
        velocity += vec3<f32>(cos(t * w + ph) * w, 0.0, -sin(t * w * 0.77 + ph * 1.3) * w * 0.77) * a;
        // Mostly small flakes, a few large clumps.
        radius = 0.008 + 0.02 * v.rnd.y * v.rnd.y * v.rnd.y;
    } else {
        radius = 0.0006 + 0.0010 * v.rnd.y;
    }
    // Streaks cover how far the particle moves across the view while the frame is exposed.
    let a_view = (view.view_from_world * vec4<f32>(center, 1.0)).xyz;
    let b_view = (view.view_from_world * vec4<f32>(center - velocity * min(precip.motion.w, 1.0 / 120.0), 1.0)).xyz;
    let depth = -a_view.z;
    if (depth < 0.15 && -b_view.z < 0.15) {
        return hidden();
    }
    // Below a pixel a particle is drawn a pixel wide and fainter, so it neither flickers nor vanishes.
    let pixel = 2.0 * max(depth, 0.15) / (view.clip_from_view[1][1] * view.viewport.w);
    let r = max(radius, pixel * select(0.6, 0.8, snow));
    let cover = sqrt(radius / r);
    let axis = b_view - a_view;
    let len = length(axis);
    var along = vec3<f32>(0.0, 1.0, 0.0);
    var across = vec3<f32>(1.0, 0.0, 0.0);
    if (len > r * 0.05) {
        along = axis / len;
        // Wound to face the camera (the back face is culled).
        let side = cross(normalize(a_view), along);
        if (length(side) > 1e-4) {
            across = normalize(side);
        } else {
            // Coming straight at the camera: the streak collapses to a dot.
            along = vec3<f32>(0.0, 1.0, 0.0);
        }
    }
    let x = (corner.x * 2.0 - 1.0) * r;
    let y = mix(-r, len + r, corner.y);
    let p = a_view + across * x + along * y;
    var out: VertexOutput;
    out.clip = view.clip_from_view * vec4<f32>(p, 1.0);
    out.local = vec3<f32>(x / r, y / r, len / r);
    // A streak spreads a flake's light over its length (gently: the eye follows it). Rain is seen as its streak.
    let spread = select(1.0 / (1.0 + 0.01 * len / r), 1.0 / (1.0 + 0.12 * max(len / r - 1.0, 0.0)), snow);
    // Fade at the box's edge (where particles wrap), and right in front of the lens.
    let edge = 1.0 - smoothstep(0.7, 1.0, length(rel) / (0.5 * size));
    let near = smoothstep(select(0.2, 0.35, snow), select(0.6, 1.2, snow), depth);
    // Close flakes are a little out of focus: softer discs.
    let soft = select(0.55, mix(0.7, 0.3, smoothstep(0.5, 3.0, depth)), snow);
    out.look = vec2<f32>(precip.color.a * cover * spread * edge * near * select(0.55, 1.0, snow), soft);
    return out;
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    // Distance from the streak's segment, in radii.
    let d = length(vec2<f32>(in.local.x, in.local.y - clamp(in.local.y, 0.0, in.local.z)));
    let a = (1.0 - smoothstep(1.0 - in.look.y, 1.0, d)) * in.look.x;
    if (a < 0.002) {
        discard;
    }
    var color = vec4<f32>(precip.color.rgb, a);
#ifdef TONEMAP_IN_SHADER
    color = tone_mapping(color, view.color_grading);
#endif
    return color;
}
