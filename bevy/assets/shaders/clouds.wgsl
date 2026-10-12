// The sandbox's cloud layer (src/weather.rs): fractal value noise in world coordinates, thresholded by the cover,
// darker where it is thick, faded out toward the sheet's edge.
#import bevy_pbr::forward_io::VertexOutput
#import bevy_pbr::mesh_view_bindings::view

struct Cloud {
    // Coverage 0..1, darkness 0..1, the layer's base (m, world), opacity.
    params: vec4<f32>,
    // Wind drift (m), then the world frame's offset from the start frame (m).
    offset: vec4<f32>,
    lit: vec4<f32>,
    shade: vec4<f32>,
    // The haze far cloud fades into, and how much.
    haze: vec4<f32>,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> cloud: Cloud;

fn hash(p: vec2<f32>) -> f32 {
    let q = fract(p * vec2<f32>(123.34, 456.21));
    let r = q + dot(q, q + 45.32);
    return fract(r.x * r.y);
}

fn noise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * (3.0 - 2.0 * f);
    let a = hash(i);
    let b = hash(i + vec2<f32>(1.0, 0.0));
    let c = hash(i + vec2<f32>(0.0, 1.0));
    let d = hash(i + vec2<f32>(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p0: vec2<f32>) -> f32 {
    var p = p0;
    var sum = 0.0;
    var amp = 0.5;
    for (var i = 0; i < 6; i = i + 1) {
        sum = sum + amp * noise(p);
        p = mat2x2<f32>(1.6, 1.2, -1.2, 1.6) * p;
        amp = amp * 0.5;
    }
    return sum;
}

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    let world = in.world_position.xz + cloud.offset.zw - cloud.offset.xy;
    let p = world / 2600.0;
    // Large shapes, their billows, and fine wisps.
    let base = fbm(p);
    let billow = fbm(p * 3.1 + vec2<f32>(17.3, -4.1));
    let d = base * 0.72 + billow * 0.28;
    let cover = cloud.params.x;
    let near = smoothstep(1.0 - cover * 0.95 - 0.03, 1.0 - cover * 0.95 + 0.12, d);
    // Far away the noise would shimmer at grazing angles: blend to the cover's average instead.
    let dist = length(in.world_position.xz - view.world_position.xz);
    let far = smoothstep(6000.0, 40000.0, dist);
    let density = mix(near, smoothstep(0.1, 0.95, cover), far);
    // Thicker cloud is darker; heavy cover and rain darken it further.
    let thickness = smoothstep(0.35, 1.0, density);
    // Seen from below it is the grey base, from above the sunlit top; thin edges catch the light either way. Which
    // one is the camera's side of the layer: far off the sheet curves down with the Earth below eye level, and is
    // still its base.
    // Blended over the cloud's depth, not switched: at the base the camera sits on the sheet and a switch flickers.
    let from_below = smoothstep(-40.0, 40.0, cloud.params.z - view.world_position.y);
    let base_shade = mix(0.3, 0.75, from_below);
    let lit = mix(cloud.lit.rgb, cloud.shade.rgb, clamp(thickness * base_shade + cloud.params.y * 0.65, 0.0, 1.0));
    let color = mix(lit, cloud.haze.rgb, smoothstep(4000.0, 60000.0, dist) * cloud.haze.a);
    // Fade out only at the sheet's edge (it follows the camera, 250 km out).
    let fade = 1.0 - smoothstep(190000.0, 248000.0, dist);
    return vec4<f32>(color, density * fade * cloud.params.w);
}
