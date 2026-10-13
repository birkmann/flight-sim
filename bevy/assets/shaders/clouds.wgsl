// World-space cumulus volume. Bounded front-to-back integration, clipped at
// opaque scene depth. Stable spatial jitter avoids animated grain when paused.
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

fn hash(p: vec3<f32>) -> f32 {
    var q = fract(p * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
}
// Gradient noise avoids the axis-aligned blocks produced by interpolated values.
fn gradient(cell: vec3<f32>, delta: vec3<f32>) -> f32 {
    let h = u32(hash(cell) * 16.0) & 15u;
    let u = select(delta.y, delta.x, h < 8u);
    let v = select(select(delta.z, delta.x, h == 12u || h == 14u), delta.y, h < 4u);
    return select(-u, u, (h & 1u) == 0u) + select(-v, v, (h & 2u) == 0u);
}
fn noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return 0.5 + 0.65 * mix(
        mix(mix(gradient(i, f), gradient(i + vec3(1.,0.,0.), f - vec3(1.,0.,0.)), u.x),
            mix(gradient(i + vec3(0.,1.,0.), f - vec3(0.,1.,0.)), gradient(i + vec3(1.,1.,0.), f - vec3(1.,1.,0.)), u.x), u.y),
        mix(mix(gradient(i + vec3(0.,0.,1.), f - vec3(0.,0.,1.)), gradient(i + vec3(1.,0.,1.), f - vec3(1.,0.,1.)), u.x),
            mix(gradient(i + vec3(0.,1.,1.), f - vec3(0.,1.,1.)), gradient(i + vec3(1.,1.,1.), f - vec3(1.,1.,1.)), u.x), u.y), u.z);
}
fn density(pos: vec3<f32>, footprint: f32) -> f32 {
    let h = (pos.y - cloud.params.z) / cloud.sun.w;
    if h <= 0.0 || h >= 1.0 { return 0.0; }
    let world = vec3(pos.x + cloud.offset.z - cloud.offset.x, pos.y,
                     pos.z + cloud.offset.w - cloud.offset.y);
    // Coherent cloud cells leave real blue-sky gaps through the whole layer.
    // Overlapping rounded lobes form cumulus towers; a common condensation
    // height keeps the bases flatter without flattening the cloud tops.
    let cell_size = 2800.0;
    let cell = floor(world.xz / cell_size);
    var body = 0.0;
    for (var z = -1; z <= 1; z++) {
        for (var x = -1; x <= 1; x++) {
            let id = cell + vec2(f32(x), f32(z));
            let seed = hash(vec3(id, 13.7));
            if seed > cloud.params.x { continue; }
            let a = hash(vec3(id, 31.1));
            let b = hash(vec3(id, 71.9));
            let center_xz = (id + vec2(0.25 + a * 0.5, 0.25 + b * 0.5)) * cell_size;
            let radius = mix(900.0, 1550.0, a) + cloud.params.y * 250.0;
            let rise = cloud.sun.w * mix(0.28, 0.46, b);
            let center = vec3(center_xz.x, cloud.params.z + rise * 0.60, center_xz.y);
            let q = (world - center) / vec3(radius, rise, radius * 0.86);
            let crown = center + vec3(radius * 0.24, rise * 0.48, -radius * 0.12);
            let r = (world - crown) / vec3(radius * 0.62, rise * 0.82, radius * 0.65);
            body = max(body, max(1.0 - length(q), 1.0 - length(r)));
        }
    }
    if body <= 0.0 { return 0.0; }
    let detail = mix(noise(world / 230.0), 0.5, smoothstep(70.0, 300.0, footprint));
    let billow = mix(noise(world / 510.0), 0.5, smoothstep(250.0, 750.0, footprint));
    let erosion = (1.0 - billow) * 0.40 + (1.0 - detail) * 0.12;
    let base = smoothstep(0.0, 0.07, h);
    return smoothstep(0.0, 0.22, body - erosion) * base * (0.8 + cloud.params.y * 0.65);
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
    let depth = prepass_depth(in.position, 0u);
    if depth > 0.0 {
        let uv = (in.position.xy - view.viewport.xy) / view.viewport.zw;
        let ndc = vec3(uv * vec2(2.0, -2.0) + vec2(-1.0, 1.0), depth);
        let scene = position_ndc_to_world(ndc);
        end = min(end, length(scene - eye));
    }
    if end <= entry { return vec4(0.0); }
    // Filter small billows to the ray step's footprint rather than undersampling
    // high-frequency erosion into grain at the horizon.
    let step_size = (end - entry) / 64.0;
    let jitter = hash(vec3(floor(in.position.xy), 0.0));
    var transmittance = 1.0;
    var radiance = vec3(0.0);
    let silver = pow(max(dot(ray, cloud.sun.xyz), 0.0), 12.0) * 0.65;
    for (var i = 0u; i < 64u; i++) {
        let distance = entry + (f32(i) + jitter) * step_size;
        let pos = eye + ray * distance;
        let d = density(pos, step_size);
        if d > 0.005 {
            // Three sunward samples approximate self-shadowing inside billows.
            let optical = density(pos + cloud.sun.xyz * 180.0, 180.0) * 0.55
                        + density(pos + cloud.sun.xyz * 420.0, 280.0) * 0.8
                        + density(pos + cloud.sun.xyz * 850.0, 420.0) * 1.1;
            let sunlight = exp(-optical * 1.7);
            let height = clamp((pos.y - cloud.params.z) / cloud.sun.w, 0.0, 1.0);
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
