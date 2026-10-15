// The piloted vehicle's shadow on the ground (src/sandbox/shadow.rs). The tiles are unlit photographs and receive no
// shadow, so a patch of ground under the vehicle reads the sun's shadow map itself and darkens the photograph where the
// vehicle hides the sun: from sunlit to lit by the sky alone.
#import bevy_pbr::forward_io::VertexOutput
#import bevy_pbr::mesh_view_bindings as view_bindings
#import bevy_pbr::mesh_view_types
#import bevy_pbr::shadows

struct GroundShadow {
    // How much of the ground's light is the sun's (0..1, the shadow's darkness), unused ×3.
    params: vec4<f32>,
}

@group(#{MATERIAL_BIND_GROUP}) @binding(0) var<uniform> ground: GroundShadow;

@fragment
fn fragment(in: VertexOutput) -> @location(0) vec4<f32> {
    if (view_bindings::lights.n_directional_lights == 0u
            || (view_bindings::lights.directional_lights[0].flags & mesh_view_types::DIRECTIONAL_LIGHT_FLAGS_SHADOWS_ENABLED_BIT) == 0u) {
        discard;
    }
    let view_z = dot(vec4<f32>(
        view_bindings::view.view_from_world[0].z,
        view_bindings::view.view_from_world[1].z,
        view_bindings::view.view_from_world[2].z,
        view_bindings::view.view_from_world[3].z
    ), in.world_position);
    let lit = shadows::fetch_directional_shadow(0u, in.world_position, normalize(in.world_normal), view_z, in.position.xy);
    // The patch fades out toward its rim, where a long shadow would otherwise end at a straight edge.
#ifdef VERTEX_UVS_A
    let rim = 1.0 - smoothstep(0.8, 1.0, length(in.uv - vec2(0.5)) * 2.0);
#else
    let rim = 1.0;
#endif
    let a = (1.0 - lit) * ground.params.x * rim;
    if (a < 0.002) {
        discard;
    }
    return vec4<f32>(0.0, 0.0, 0.0, a);
}
