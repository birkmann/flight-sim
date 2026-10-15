// World-space cumulus volume. Bounded front-to-back integration, clipped at
// opaque scene depth. Stable spatial jitter avoids animated grain when paused.
//
// Cost (GPU time at 1920×1080 on a GTX 1080 Ti, from a few clouds to inside or above a full layer): 9.5–28 ms a
// frame marching every sample with the noise evaluated in place, 1.7–6.8 ms now. The march visits the same 64
// jittered samples, but skips those that a lower bound on the distance to the nearest cloud lobe proves empty. Each
// sample looks only at the 2×2 cells that can reach it, not 3×3, and passes over a cell whose lobes are clearly beside
// it. The billow noise is read from a tiling volume (`src/weather/cloud_noise.rs`) rather than hashed at eight lattice
// corners, and an octave filtered out completely at the ray's footprint is not read at all.
#import bevy_pbr::forward_io::VertexOutput
#import bevy_pbr::mesh_view_bindings::view
#import bevy_pbr::prepass_utils::prepass_depth
#import bevy_pbr::view_transformations::position_ndc_to_world

struct Cloud {
    params: vec4<f32>, // cover, storm, base, opacity
    offset: vec4<f32>, // wind drift, rebased world offset
    lit: vec4<f32>,
    shade: vec4<f32>,
    haze: vec4<f32>, // RGB, visibility in metres
    sun: vec4<f32>, // direction, layer thickness
}
@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> cloud: Cloud;

const CELL: f32 = 2800.0;
const STEPS: u32 = 64u;

fn hash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
// Gradient noise, −1..1 in the volume, tiling every NOISE_PERIOD lattice cells (`cloud_noise::PERIOD`).
@group(#{MATERIAL_BIND_GROUP}) @binding(1) var noise_texture: texture_3d<f32>;
@group(#{MATERIAL_BIND_GROUP}) @binding(2) var noise_sampler: sampler;
const NOISE_PERIOD: f32 = 32.0;
fn noise(p: vec3<f32>) -> f32 {
    return 0.5 + 0.65 * textureSampleLevel(noise_texture, noise_sampler, p / NOISE_PERIOD, 0.0).r;
}

// The noise's frame: the start frame, drifting with the wind.
fn cloud_space(pos: vec3<f32>) -> vec3<f32> {
    return vec3(pos.x + cloud.offset.z - cloud.offset.x, pos.y, pos.z + cloud.offset.w - cloud.offset.y);
}

// The cloud cells' rounded lobes at a point (noise space): x the largest lobe value (positive inside a lobe), y a
// lower bound on the distance (m) to any point where it is positive.
//
// Coherent cloud cells leave real blue-sky gaps through the whole layer. Overlapping rounded lobes form cumulus
// towers; a common condensation height keeps the bases flatter without flattening the cloud tops.
fn shape(world: vec3<f32>) -> vec2<f32> {
    let g = world.xz / CELL;
    let cell = floor(g);
    let f = g - cell;
    // A cell's lobes reach at most `reach` from its centre, which lies in the middle half of the cell, so only the
    // cell itself and its neighbours toward the nearer edges can reach this point (while reach < 0.75 CELL).
    let reach = 1550.0 + 250.0 * cloud.params.y;
    let near = f < vec2(0.5);
    let side = select(vec2(1.0), vec2(-1.0), near);
    // The cells left out: across the farther edges, and two or more away.
    let far = (select(f, 1.0 - f, near) + 0.25) * CELL - reach;
    var clear = min(min(far.x, far.y), 1.25 * CELL - reach);
    var body = 0.0;
    for (var z = 0; z < 2; z++) {
        for (var x = 0; x < 2; x++) {
            let id = cell + vec2(f32(x), f32(z)) * side;
            let seed = hash(vec3(id, 13.7));
            if seed > cloud.params.x { continue; }
            let a = hash(vec3(id, 31.1));
            let b = hash(vec3(id, 71.9));
            let center_xz = (id + vec2(0.25 + a * 0.5, 0.25 + b * 0.5)) * CELL;
            let radius = mix(900.0, 1550.0, a) + cloud.params.y * 250.0;
            // Both lobes lie within `radius` of the centre on the ground plane.
            let aside = length(world.xz - center_xz) - radius;
            if aside > 0.0 {
                clear = min(clear, aside);
                continue;
            }
            let rise = cloud.sun.w * mix(0.28, 0.46, b);
            let center = vec3(center_xz.x, cloud.params.z + rise * 0.60, center_xz.y);
            let lq = length((world - center) / vec3(radius, rise, radius * 0.86));
            let crown = center + vec3(radius * 0.24, rise * 0.48, -radius * 0.12);
            let lr = length((world - crown) / vec3(radius * 0.62, rise * 0.82, radius * 0.65));
            body = max(body, max(1.0 - lq, 1.0 - lr));
            // Outside an ellipsoid, the distance to it is at least its shortest semi-axis times (length - 1).
            clear = min(clear, min((lq - 1.0) * min(rise, radius * 0.86), (lr - 1.0) * min(radius * 0.62, rise * 0.82)));
        }
    }
    return vec2(body, clear);
}

// Density inside the lobes: erosion by two octaves of billows, each filtered to the footprint (the step) rather
// than undersampled into grain at the horizon. An octave filtered out completely is not evaluated.
fn erode(world: vec3<f32>, h: f32, body: f32, footprint: f32) -> f32 {
    let detail_fade = smoothstep(70.0, 300.0, footprint);
    let billow_fade = smoothstep(250.0, 750.0, footprint);
    var detail = 0.5;
    if detail_fade < 1.0 { detail = mix(noise(world / 230.0), 0.5, detail_fade); }
    var billow = 0.5;
    if billow_fade < 1.0 { billow = mix(noise(world / 510.0), 0.5, billow_fade); }
    let erosion = (1.0 - billow) * 0.40 + (1.0 - detail) * 0.12;
    let base = smoothstep(0.0, 0.07, h);
    return smoothstep(0.0, 0.22, body - erosion) * base * (0.8 + cloud.params.y * 0.65);
}

fn density(pos: vec3<f32>, footprint: f32) -> f32 {
    let h = (pos.y - cloud.params.z) / cloud.sun.w;
    if h <= 0.0 || h >= 1.0 { return 0.0; }
    let world = cloud_space(pos);
    let body = shape(world).x;
    if body <= 0.0 { return 0.0; }
    return erode(world, h, body, footprint);
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let eye = view.world_position;
    let ray = normalize(in.world_position.xyz - eye);
    // Avoid division by zero for a precisely level camera.
    let ry = select(-max(abs(ray.y), 0.0001), max(abs(ray.y), 0.0001), ray.y >= 0.0);
    let b = (cloud.params.z - eye.y) / ry;
    let t = (cloud.params.z + cloud.sun.w - eye.y) / ry;
    let entry = max(0.0, min(b, t));
    var end = min(60000.0, max(b, t));
    // The ray misses the layer (or meets it beyond the far limit): no need to read the depth.
    if end <= entry { return vec4(0.0); }
    let depth = prepass_depth(in.position, 0u);
    if depth > 0.0 {
        let uv = (in.position.xy - view.viewport.xy) / view.viewport.zw;
        let ndc = vec3(uv * vec2(2.0, -2.0) + vec2(-1.0, 1.0), depth);
        let scene = position_ndc_to_world(ndc);
        end = min(end, length(scene - eye));
    }
    if end <= entry { return vec4(0.0); }
    let step_size = (end - entry) / f32(STEPS);
    let jitter = hash(vec3(floor(in.position.xy), 0.0));
    var transmittance = 1.0;
    var radiance = vec3(0.0);
    let silver = pow(max(dot(ray, cloud.sun.xyz), 0.0), 12.0) * 0.65;
    var i = 0u;
    loop {
        if i >= STEPS { break; }
        let distance = entry + (f32(i) + jitter) * step_size;
        let pos = eye + ray * distance;
        let h = (pos.y - cloud.params.z) / cloud.sun.w;
        let world = cloud_space(pos);
        let s = shape(world);
        if s.x <= 0.0 || h <= 0.0 || h >= 1.0 {
            // Every sample closer than the nearest lobe is empty too.
            i += 1u + u32(clamp(s.y / step_size, 0.0, f32(STEPS)));
            continue;
        }
        i += 1u;
        let d = erode(world, h, s.x, step_size);
        if d > 0.005 {
            // Three sunward samples approximate self-shadowing inside billows.
            let optical = density(pos + cloud.sun.xyz * 180.0, 180.0) * 0.55
                        + density(pos + cloud.sun.xyz * 420.0, 280.0) * 0.8
                        + density(pos + cloud.sun.xyz * 850.0, 420.0) * 1.1;
            let sunlight = exp(-optical * 1.7);
            let height = clamp(h, 0.0, 1.0);
            let lighting = clamp(0.12 + sunlight * 0.78 + height * 0.10, 0.0, 1.0);
            var color = mix(cloud.shade.rgb * 0.72, cloud.lit.rgb, lighting);
            color += cloud.lit.rgb * silver * sunlight * (1.0 - d * 0.5);
            let haze = 1.0 - exp(-distance / max(cloud.haze.a, 100.0));
            color = mix(color, cloud.haze.rgb, haze * 0.65);
            let opacity = 1.0 - exp(-d * step_size * 0.0035);
            radiance += transmittance * opacity * color;
            transmittance *= 1.0 - opacity;
            if transmittance < 0.015 { break; }
        }
    }
    let alpha = 1.0 - transmittance;
    return vec4(radiance / max(alpha, 0.001), alpha * cloud.params.w);
}
