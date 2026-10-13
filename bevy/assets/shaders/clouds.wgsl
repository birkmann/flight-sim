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
fn noise(p: vec3<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1.,0.,0.)), u.x),
                   mix(hash(i + vec3(0.,1.,0.)), hash(i + vec3(1.,1.,0.)), u.x), u.y),
               mix(mix(hash(i + vec3(0.,0.,1.)), hash(i + vec3(1.,0.,1.)), u.x),
                   mix(hash(i + vec3(0.,1.,1.)), hash(i + vec3(1.,1.,1.)), u.x), u.y), u.z);
}
fn density(pos: vec3<f32>) -> f32 {
    let h = (pos.y - cloud.params.z) / cloud.sun.w;
    if h <= 0.0 || h >= 1.0 { return 0.0; }
    let world = vec3(pos.x + cloud.offset.z - cloud.offset.x, pos.y,
                     pos.z + cloud.offset.w - cloud.offset.y);
    let p = world / vec3(2300.0, 1500.0, 2300.0);
    let shape = noise(p) * 0.625 + noise(p * 2.03 + 19.1) * 0.25 + noise(p * 4.07) * 0.125;
    // Broad connected bases and eroded, rounded tops; coverage changes the
    // occupied volume, not the opacity of a uniform grey sheet.
    let profile = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.42, 1.0, h));
    let threshold = 0.70 - cloud.params.x * 0.58;
    let body = smoothstep(threshold, threshold + 0.14, shape * profile);
    let erosion = noise(p * 9.0 + 7.0) * 0.22 * (1.0 - body);
    return max(0.0, body - erosion) * (0.75 + cloud.params.y * 0.65);
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
    let step_size = (end - entry) / 36.0;
    let jitter = hash(vec3(floor(in.position.xy), 0.0));
    var transmittance = 1.0;
    var radiance = vec3(0.0);
    let silver = pow(max(dot(ray, cloud.sun.xyz), 0.0), 12.0) * 0.65;
    for (var i = 0u; i < 36u; i++) {
        let distance = entry + (f32(i) + jitter) * step_size;
        let pos = eye + ray * distance;
        let d = density(pos);
        if d > 0.005 {
            // Three sunward samples approximate self-shadowing inside billows.
            let optical = density(pos + cloud.sun.xyz * 180.0) * 0.55
                        + density(pos + cloud.sun.xyz * 420.0) * 0.8
                        + density(pos + cloud.sun.xyz * 850.0) * 1.1;
            let sunlight = exp(-optical * 1.7);
            let height = clamp((pos.y - cloud.params.z) / cloud.sun.w, 0.0, 1.0);
            let lighting = clamp(0.18 + sunlight * 0.7 + height * 0.18, 0.0, 1.0);
            var color = mix(cloud.shade.rgb * 0.72, cloud.lit.rgb, lighting);
            color += cloud.lit.rgb * silver * sunlight * (1.0 - d * 0.5);
            let haze = 1.0 - exp(-distance / max(cloud.haze.a, 100.0));
            color = mix(color, cloud.haze.rgb, haze * 0.85);
            let opacity = 1.0 - exp(-d * step_size * 0.0035);
            radiance += transmittance * opacity * color;
            transmittance *= 1.0 - opacity;
            if transmittance < 0.015 { break; }
        }
    }
    let alpha = 1.0 - transmittance;
    return vec4(radiance / max(alpha, 0.001), alpha * cloud.params.w);
}
