/* Measured Decision · 360 evidence viewer.

   A dependency-free equirectangular viewer. It renders a full-screen quad and
   resolves the view direction per pixel, so no sphere mesh or external 3D
   library is required. Photos, equirectangular MP4 exports, and non-spatial
   media all open through the same entry point, which keeps "open the evidence"
   a single action everywhere in the Studio.

   window.MDAIPano360.open({ src, mediaType, title, subtitle, spatial, trim, actions,
                            markers, evidenceId, canReviewMarkers,
                            onMarkerReview, onMarkerPlace, onMarkerRequest })
*/
(() => {
  const VERTEX_SHADER = `
    attribute vec2 position;
    varying vec2 vScreen;
    void main() {
      vScreen = position;
      gl_Position = vec4(position, 0.0, 1.0);
    }`;

  const FRAGMENT_SHADER = `
    precision highp float;
    varying vec2 vScreen;
    uniform sampler2D source;
    uniform float yaw;
    uniform float pitch;
    uniform float tanHalfFov;
    uniform float aspect;
    const float PI = 3.14159265359;
    void main() {
      vec3 ray = normalize(vec3(vScreen.x * tanHalfFov * aspect, vScreen.y * tanHalfFov, -1.0));
      float cp = cos(pitch);
      float sp = sin(pitch);
      vec3 tilted = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
      float cy = cos(yaw);
      float sy = sin(yaw);
      vec3 dir = vec3(tilted.x * cy + tilted.z * sy, tilted.y, -tilted.x * sy + tilted.z * cy);
      float u = atan(dir.x, -dir.z) / (2.0 * PI) + 0.5;
      float v = acos(clamp(dir.y, -1.0, 1.0)) / PI;
      /* Half a mip level sharper than the hardware would pick on its own:
         trilinear filtering trades a little sharpness for a still image, and
         the headset reported the trade as slightly soft. Biasing towards the
         finer level restores the detail while keeping the shimmer gone. */
      gl_FragColor = texture2D(source, vec2(u, v), -0.5);
    }`;

  /* The immersive path needs its own pair of shaders, and not because somebody
     preferred matrices. A headset hands back its own projection for each eye —
     asymmetric, and different between them — and there is no yaw, pitch and
     field of view that describes it. Unprojecting the pixel uses whatever the
     device gives, exactly as given.

     The last two lines are copied from the flat shader on purpose. They are the
     convention that decides which way round the sphere is, and two copies of it
     that drift apart would put the ceiling underfoot in the headset while the
     laptop looked perfect. */
  const XR_VERTEX_SHADER = `
    attribute vec2 position;
    varying vec2 vScreen;
    void main() {
      vScreen = position;
      gl_Position = vec4(position, 0.0, 1.0);
    }`;

  const XR_FRAGMENT_SHADER = `
    precision highp float;
    varying vec2 vScreen;
    uniform sampler2D source;
    uniform mat4 invProjection;
    uniform mat3 viewRotation;
    uniform vec3 eyeOffset;
    uniform float sphereRadius;
    const float PI = 3.14159265359;
    void main() {
      vec4 eye = invProjection * vec4(vScreen, -1.0, 1.0);
      vec3 dir = normalize(viewRotation * normalize(eye.xyz / eye.w));
      /* A room captured on one lens has no stereo, so nothing tells the eye
         how far a wall is and the room reads larger than it is. The first
         answer warped angles around a centre, and every centre was wrong:
         glued to the gaze the room flowed after the head, parked anywhere
         else the view went round wherever the gaze was not. This one warps
         nothing. The sphere is given a finite radius around the head, each
         eye is placed at its true offset, and the two eyes' rays land on
         honestly different texels — real disparity, which is the cue the
         brain actually uses for distance. The capture keeps its exact
         angular truth; only the felt distance of the walls changes. A
         non-positive radius is the capture as shot, at infinity. */
      if (sphereRadius > 0.0) {
        float along = dot(eyeOffset, dir);
        float t = sqrt(max(along * along + sphereRadius * sphereRadius - dot(eyeOffset, eyeOffset), 0.0)) - along;
        dir = normalize(eyeOffset + t * dir);
      }
      float u = atan(dir.x, -dir.z) / (2.0 * PI) + 0.5;
      float v = acos(clamp(dir.y, -1.0, 1.0)) / PI;
      /* Half a mip level sharper than the hardware would pick on its own:
         trilinear filtering trades a little sharpness for a still image, and
         the headset reported the trade as slightly soft. Biasing towards the
         finer level restores the detail while keeping the shimmer gone. */
      gl_FragColor = texture2D(source, vec2(u, v), -0.5);
    }`;

  /* Where a marker is, as a direction, derived from the shader rather than
     guessed at.

     The shader reads the sphere with
        u = atan(dir.x, -dir.z) / 2PI + 0.5
        v = acos(dir.y) / PI
     so running those two backwards is the only mapping that puts a pin on the
     thing it was placed on. A pin that is a few degrees out looks like a pin
     somebody placed carelessly, which is the worst kind of wrong: believable. */
  function markerDirection(u, v) {
    const theta = (u - 0.5) * Math.PI * 2;
    const phi = v * Math.PI;
    const horizontal = Math.sin(phi);
    return [horizontal * Math.sin(theta), Math.cos(phi), -horizontal * Math.cos(theta)];
  }

  /* The same journey back, so a test can prove the pair are inverses instead of
     taking it on trust. */
  function directionToUV(direction) {
    const [x, y, z] = direction;
    return {
      u: Math.atan2(x, -z) / (Math.PI * 2) + 0.5,
      v: Math.acos(Math.max(-1, Math.min(1, y))) / Math.PI,
    };
  }

  if (typeof window !== "undefined") {
    window.MDAIPano360Math = { markerDirection, directionToUV };
  }

  const MARKER_VERTEX_SHADER = `
    attribute vec2 corner;
    uniform mat4 projection;
    uniform mat3 viewRotationInverse;
    uniform vec3 markerDirection;
    uniform float markerSize;
    uniform float markerDistance;
    uniform vec3 eyeOffset;
    varying vec2 vCorner;
    void main() {
      vCorner = corner;
      /* The pin sits at the same distance the sphere is drawn at and always
         faces the viewer: its plane is built from the view's own right and
         up axes, so it never turns edge-on however somebody walks around it.
         Sharing the sphere's distance matters in stereo — a pin left at a
         different depth than the wall it marks floats uncomfortably off it. */
      vec3 centre = markerDirection * markerDistance - eyeOffset;
      vec3 right = normalize(vec3(viewRotationInverse[0][0], viewRotationInverse[1][0], viewRotationInverse[2][0]));
      vec3 up = normalize(vec3(viewRotationInverse[0][1], viewRotationInverse[1][1], viewRotationInverse[2][1]));
      vec3 world = centre + (right * corner.x + up * corner.y) * markerSize;
      gl_Position = projection * vec4(mat3(
        viewRotationInverse[0][0], viewRotationInverse[0][1], viewRotationInverse[0][2],
        viewRotationInverse[1][0], viewRotationInverse[1][1], viewRotationInverse[1][2],
        viewRotationInverse[2][0], viewRotationInverse[2][1], viewRotationInverse[2][2]
      ) * world, 1.0);
    }`;

  const MARKER_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec2 vCorner;
    uniform vec4 markerColour;
    uniform float looking;
    uniform float reticle;
    void main() {
      float radius = length(vCorner);
      if (reticle > 0.5) {
        /* A sight, not a target.
         *
         * The aim used to be drawn by this same shader as the same ring the
         * pins are: identical shape, brighter, and parked in the middle of
         * the view. So the most button-like object in the room was the one
         * thing that can never be pressed — it follows the head, so it can
         * never be aimed at — and it was pressed for four rounds by somebody
         * doing exactly what they had been told to do. Four ticks and an
         * open centre cannot be mistaken for a thing in the room. */
        float ax = abs(vCorner.x);
        float ay = abs(vCorner.y);
        float arm = 0.19;
        float gap = 0.34;
        float horizontal = smoothstep(arm, arm * 0.55, ay)
          * smoothstep(gap * 0.8, gap, ax) * smoothstep(1.0, 0.9, ax);
        float vertical = smoothstep(arm, arm * 0.55, ax)
          * smoothstep(gap * 0.8, gap, ay) * smoothstep(1.0, 0.9, ay);
        float mark = max(horizontal, vertical);
        if (mark <= 0.01) discard;
        gl_FragColor = vec4(markerColour.rgb, markerColour.a * mark);
      } else {
        if (radius > 1.0) discard;
        /* A ring rather than a blob: it has to be visible against timber and
           daylight alike without hiding what it points at. */
        float edge = smoothstep(1.0, 0.86, radius);
        float hole = smoothstep(0.52, 0.66, radius);
        float alpha = edge * mix(hole, 1.0, looking * 0.55);
        gl_FragColor = vec4(markerColour.rgb, markerColour.a * alpha);
      }
    }`;

  /* The room menu: text baked to a canvas, carried into the scene as a quad
     that faces the viewer exactly the way a pin does. WebGL has no words of
     its own, and a person inside a headset must not have to take it off to
     read which room is which. */
  const LABEL_VERTEX_SHADER = `
    attribute vec2 corner;
    varying vec2 vUv;
    varying vec3 vWorld;
    uniform mat4 projection;
    uniform mat3 viewRotationInverse;
    uniform vec3 labelDirection;
    uniform vec2 labelSize;
    uniform float labelDistance;
    uniform vec3 eyeOffset;
    void main() {
      vUv = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
      vec3 centre = labelDirection * labelDistance - eyeOffset;
      vec3 right = normalize(vec3(viewRotationInverse[0][0], viewRotationInverse[1][0], viewRotationInverse[2][0]));
      vec3 up = normalize(vec3(viewRotationInverse[0][1], viewRotationInverse[1][1], viewRotationInverse[2][1]));
      vec3 world = centre + right * corner.x * labelSize.x + up * corner.y * labelSize.y;
      vWorld = world;
      gl_Position = projection * vec4(mat3(
        viewRotationInverse[0][0], viewRotationInverse[0][1], viewRotationInverse[0][2],
        viewRotationInverse[1][0], viewRotationInverse[1][1], viewRotationInverse[1][2],
        viewRotationInverse[2][0], viewRotationInverse[2][1], viewRotationInverse[2][2]
      ) * world, 1.0);
    }`;

  const LABEL_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec2 vUv;
    varying vec3 vWorld;
    uniform sampler2D label;
    uniform sampler2D room;
    uniform float looking;
    uniform float dwell;
    uniform float glass;
    void main() {
      vec4 colour = texture2D(label, vUv);
      /* A bar filling along the bottom of the panel while somebody holds
         their gaze on it. Without it, waiting is indistinguishable from a
         control that does nothing — which is how the pinch felt. */
      if (dwell > 0.0 && vUv.y > 0.86 && vUv.x < dwell) {
        gl_FragColor = vec4(0.55, 0.91, 0.95, 1.0);
        return;
      }
      if (glass < 0.5) {
        gl_FragColor = vec4(colour.rgb + vec3(looking * 0.18), colour.a);
        return;
      }
      /* Frosted, over the room itself.
       *
       * A panel that hides the capture takes away the one thing somebody put
       * the headset on for. The capture is already in a mipmapped texture,
       * so what lies behind this fragment can be sampled at a coarse level —
       * which IS a blur, at no cost — and the plate becomes glass over the
       * real room rather than a painted imitation of it.
       *
       * The baked plate is dark and its lettering is bright, so brightness
       * alone separates ink from plate: the plate turns to glass, the
       * lettering stays solid and readable against whatever is behind it. */
      vec3 look = normalize(vWorld);
      float u = atan(look.x, -look.z) / 6.2831853 + 0.5;
      float v = acos(clamp(look.y, -1.0, 1.0)) / 3.14159265;
      vec3 behind = texture2D(room, vec2(u, v), 5.0).rgb;
      float ink = smoothstep(0.22, 0.55, max(max(colour.r, colour.g), colour.b));
      /* Cool and darkened, so white lettering keeps its contrast over a
         bright wall as well as a dark one. */
      vec3 frost = mix(behind * 0.55, vec3(0.04, 0.09, 0.14), 0.55);
      vec3 rgb = mix(frost, colour.rgb + vec3(looking * 0.18), ink);
      float alpha = colour.a * mix(0.62, 1.0, ink);
      gl_FragColor = vec4(rgb, alpha);
    }`;

  function invert4(m) {
    const out = new Float32Array(16);
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return out;
    det = 1.0 / det;
    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
  }

  const STYLE = `
    .pano-overlay{position:fixed;inset:0;z-index:120;display:flex;flex-direction:column;background:#04090f}
    .pano-overlay[hidden]{display:none}
    .pano-bar{display:flex;align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top)) 14px 10px;background:linear-gradient(180deg,rgba(4,9,15,.94),rgba(4,9,15,0));position:absolute;inset:0 0 auto;z-index:2}
    .pano-bar .pano-titles{min-width:0;flex:1}
    .pano-bar .pano-vr{background:rgba(91,216,206,.16);border-color:rgba(91,216,206,.5);color:#9fefe8}
    .pano-scale{flex:0 0 auto;display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border:1px solid #2b425c;border-radius:10px;background:rgba(10,20,33,.72);color:#8fa2b5;font-size:11px}
    .pano-scale[hidden]{display:none}
    .pano-scale input{width:104px;accent-color:#52d2df}
    .pano-scale em{font-style:normal;color:#edf4f7;font-variant-numeric:tabular-nums;min-width:38px;text-align:right}
    @media (max-width:640px){.pano-scale span{display:none}.pano-scale input{width:76px}}
    .pano-bar strong{display:block;font-size:15px;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pano-bar small{display:block;margin-top:2px;color:#8fa2b5;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .pano-icon{flex:0 0 auto;min-width:44px;min-height:44px;padding:0 12px;border:1px solid #2b425c;border-radius:10px;background:rgba(10,20,33,.72);color:#edf4f7;font:inherit;font-size:13px;cursor:pointer}
    .pano-icon:hover{border-color:#52d2df}
    .pano-icon[aria-pressed="true"]{border-color:#52d2df;background:rgba(82,210,223,.16);color:#52d2df}
    .pano-stage{position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden;touch-action:none}
    .pano-stage canvas{width:100%;height:100%;display:block;cursor:grab}
    .pano-stage canvas.dragging{cursor:grabbing}
    .pano-stage>img,.pano-stage>video.pano-flat{max-width:100%;max-height:100%;object-fit:contain}
    .pano-stage>.pano-doc{padding:32px;text-align:center;color:#a5b8c8}
    .pano-stage>.pano-doc a{display:inline-block;margin-top:16px;padding:14px 22px;border-radius:10px;background:#52d2df;color:#06111d;font-weight:600;text-decoration:none}
    .pano-say{position:absolute;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 32px);text-align:center;padding:11px 16px;border-radius:12px;background:rgba(4,9,15,.92);border:1px solid rgba(255,255,255,.14);color:#dbe7ef;font-size:13px;line-height:1.5;z-index:3}
    .pano-say[hidden]{display:none}
    .pano-say.bad{border-color:rgba(255,140,140,.5);color:#ffc9c9}
    .pano-say.good{border-color:rgba(127,214,168,.5);color:#bdf0d4}
    .pano-hint{position:absolute;left:50%;top:calc(74px + env(safe-area-inset-top));transform:translateX(-50%);max-width:calc(100% - 32px);text-align:center;padding:8px 14px;border-radius:999px;background:rgba(4,9,15,.72);color:#a5b8c8;font-size:12px;pointer-events:none;transition:opacity 400ms ease}
    .pano-foot{display:flex;flex-wrap:wrap;gap:8px;padding:10px 14px calc(12px + env(safe-area-inset-bottom));background:linear-gradient(0deg,rgba(4,9,15,.94),rgba(4,9,15,0));position:absolute;inset:auto 0 0;z-index:2}
    .pano-foot button{flex:1 1 auto;min-height:46px;padding:0 16px;border:1px solid #35506a;border-radius:10px;background:rgba(10,20,33,.82);color:#edf4f7;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .pano-foot button.primary{border-color:#52d2df;background:#52d2df;color:#06111d}
    .pano-playback{position:absolute;left:50%;bottom:calc(74px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:999px;background:rgba(4,9,15,.78);z-index:2}
    .pano-playback button{min-width:44px;min-height:36px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:#edf4f7;font:inherit;cursor:pointer}
    .pano-playback input{width:min(46vw,260px)}
    .pano-playback .pano-window{min-width:auto;padding:0 12px;font-size:12px;white-space:nowrap}
    .pano-playback .pano-window[aria-pressed="true"]{background:rgba(82,210,223,.18);color:#52d2df}
    .pano-trim-note{position:absolute;left:50%;bottom:calc(122px + env(safe-area-inset-bottom));transform:translateX(-50%);max-width:calc(100% - 32px);text-align:center;padding:6px 12px;border-radius:999px;background:rgba(4,9,15,.72);color:#a5b8c8;font-size:12px;z-index:2;pointer-events:none}

    /* Markers sit above the sphere and are positioned every frame from the same
       view the shader draws, so a pin never drifts off the thing it points at. */
    .pano-markers{position:absolute;inset:0;pointer-events:none;z-index:1}
    /* The pin itself has no size: the dot is centred on the anchor and the label
       hangs off it, so the ring sits on the thing and not next to it. */
    .pano-pin{position:absolute;left:0;top:0;width:0;height:0;padding:0;border:0;background:none;color:#edf4f7;font:inherit;cursor:pointer;pointer-events:none;white-space:nowrap}
    .pano-pin i{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border-radius:50%;border:2px solid #52d2df;background:rgba(4,9,15,.55);box-shadow:0 0 0 4px rgba(82,210,223,.16);transition:transform 120ms ease}
    .pano-pin b{position:absolute;left:18px;top:-11px;display:block;font:600 12px/1 inherit;padding:6px 10px;border-radius:999px;background:rgba(4,9,15,.82);border:1px solid rgba(255,255,255,.12);max-width:44vw;overflow:hidden;text-overflow:ellipsis}
    .pano-pin.state-ok i{border-color:#6fd8a8;box-shadow:0 0 0 4px rgba(111,216,168,.16)}
    .pano-pin.state-wait i{border-color:#e8b070;box-shadow:0 0 0 4px rgba(232,176,112,.16)}
    .pano-pin.state-off i{border-color:#7f8fa0;box-shadow:none;opacity:.6}
    .pano-pin.far b{display:none}
    .pano-pin.far i{left:-7px;top:-7px;width:14px;height:14px}
    .pano-pin[aria-expanded="true"] i{transform:scale(1.25)}
    .pano-pin:focus-visible{outline:2px solid #52d2df;outline-offset:6px;border-radius:999px}
    .pano-reticle{position:absolute;left:50%;top:50%;width:46px;height:46px;margin:-23px 0 0 -23px;border:1px solid rgba(82,210,223,.7);border-radius:50%;pointer-events:none;z-index:1}
    .pano-reticle::after{content:"";position:absolute;inset:20px;border-radius:50%;background:#52d2df}
    .pano-card{position:absolute;inset:auto 0 0;z-index:4;max-height:72%;overflow:auto;padding:18px 18px calc(18px + env(safe-area-inset-bottom));background:#0b1622;border-top:1px solid #24384c;border-radius:16px 16px 0 0;box-shadow:0 -18px 44px rgba(0,0,0,.45)}
    .pano-card h3{margin:8px 0 4px;font-size:17px;line-height:1.25}
    .pano-card p{margin:0 0 10px;color:#a5b8c8;font-size:13px;line-height:1.5}
    .pano-card dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;margin:0 0 14px;font-size:13px}
    .pano-card dt{color:#7f96aa}
    .pano-card dd{margin:0;color:#dce7ef}
    .pano-card dd.missing{color:#e8b070}
    .pano-chip{display:inline-block;padding:4px 10px;border-radius:999px;border:1px solid;font-size:11px;font-style:normal;font-weight:600}
    .pano-chip.review{color:#e8b070;border-color:rgba(232,176,112,.5);background:rgba(232,176,112,.1)}
    .pano-chip.ok{color:#6fd8a8;border-color:rgba(111,216,168,.5);background:rgba(111,216,168,.1)}
    .pano-chip.wait{color:#9db4ff;border-color:rgba(157,180,255,.5);background:rgba(157,180,255,.1)}
    .pano-chip.off{color:#93a5b6;border-color:rgba(147,165,182,.45);background:rgba(147,165,182,.1)}
    .pano-card-actions{display:flex;flex-wrap:wrap;gap:8px}
    .pano-card-actions button{flex:1 1 auto;min-height:44px;padding:0 14px;border:1px solid #35506a;border-radius:10px;background:rgba(10,20,33,.9);color:#edf4f7;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
    .pano-card-actions button.primary{border-color:#52d2df;background:#52d2df;color:#06111d}
    .pano-card-actions button.quiet{border-color:#2b3f55;color:#a5b8c8;font-weight:500}
    .pano-card-close{position:absolute;right:12px;top:12px;min-width:40px;min-height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.06);color:#a5b8c8;font:inherit;cursor:pointer}
    .pano-list{position:absolute;inset:auto 0 0;z-index:4;max-height:72%;overflow:auto;padding:14px 14px calc(14px + env(safe-area-inset-bottom));background:#0b1622;border-top:1px solid #24384c;border-radius:16px 16px 0 0}
    .pano-list h3{margin:0 0 10px;font-size:14px;color:#a5b8c8;font-weight:600}
    .pano-list button.row{display:flex;width:100%;align-items:center;gap:10px;min-height:48px;margin-bottom:6px;padding:8px 12px;border:1px solid #22364a;border-radius:10px;background:rgba(10,20,33,.7);color:#edf4f7;font:inherit;font-size:13px;text-align:left;cursor:pointer}
    .pano-list button.row span{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    @media(max-width:640px){.pano-bar small{display:none}}
  `;

  let root = null;
  let stage = null;
  let footer = null;
  let titleNode = null;
  let subtitleNode = null;
  let hintNode = null;
  let gyroButton = null;
  let vrButton = null;
  let scaleControl = null;
  let scaleInput = null;
  let scaleValue = null;
  let markerButton = null;
  let playback = null;
  let trimNote = null;
  /* The live sphere, reachable by swapRoom: choosing another room from
     inside the headset must reload what the sphere shows, never the page. */
  let activeSphere = null;
  let activeSwapMedia = null;
  let session = null;
  let restoreOverflow = "";

  function injectStyle() {
    if (document.getElementById("pano360-style")) return;
    const style = document.createElement("style");
    style.id = "pano360-style";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function escapeText(value) {
    const span = document.createElement("span");
    span.textContent = value == null ? "" : value;
    return span.innerHTML;
  }

  function build() {
    injectStyle();
    root = document.createElement("div");
    root.className = "pano-overlay";
    root.hidden = true;
    root.innerHTML = `
      <div class="pano-bar">
        <button class="pano-icon" type="button" data-pano-close aria-label="Close viewer">← Back</button>
        <div class="pano-titles"><strong data-pano-title>Evidence</strong><small data-pano-subtitle></small></div>
        <button class="pano-icon" type="button" data-pano-markers hidden>◎ Mark</button>
        <button class="pano-icon" type="button" data-pano-gyro aria-pressed="false" hidden>Look around</button>
        <!-- Only ever shown once the headset has said it can do this. A button
             that fails when pressed is worse than one that was never there. -->
        <button class="pano-icon pano-vr" type="button" data-pano-vr hidden>◉ Stand in this room</button>
        <!-- A monoscopic capture has no stereo, so nothing tells the eye how
             far a wall is and a true-scale room still reads as too large.
             This sets how far the walls feel, by drawing the sphere at a
             finite distance and giving each eye its own view of it. Angles
             are never distorted, and the capture itself is never altered. -->
        <label class="pano-scale" data-pano-scale hidden>
          <span>Room size</span>
          <input type="range" min="30" max="100" step="5" value="100" data-pano-scale-input
                 aria-label="How close the walls of the room feel in the headset, in percent">
          <em data-pano-scale-value>100%</em>
        </label>
      </div>
      <div class="pano-stage" data-pano-stage></div>
      <div class="pano-foot" data-pano-foot></div>`;
    document.body.appendChild(root);
    stage = root.querySelector("[data-pano-stage]");
    footer = root.querySelector("[data-pano-foot]");
    titleNode = root.querySelector("[data-pano-title]");
    subtitleNode = root.querySelector("[data-pano-subtitle]");
    gyroButton = root.querySelector("[data-pano-gyro]");
    vrButton = root.querySelector("[data-pano-vr]");
    scaleControl = root.querySelector("[data-pano-scale]");
    scaleInput = root.querySelector("[data-pano-scale-input]");
    scaleValue = root.querySelector("[data-pano-scale-value]");
    markerButton = root.querySelector("[data-pano-markers]");
    markerButton.addEventListener("click", openMarkerList);
    root.querySelector("[data-pano-close]").addEventListener("click", close);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !root.hidden) close();
    });
  }


  /* Remembered, because somebody who has settled on how a room should read
     should not have to settle on it again every time they open one. What is
     stored is the number on the slider — the thing a person chose — not the
     shader's factor, which is an implementation detail that may change. */
  const SIZE_KEY = "mdai.pano360.roomSize";
  /* The floor was 60% until a person stood in a real room and reported that
     even at 60% an outlet still read the size of a head — a monoscopic
     sphere gives the eye no distance cues, and how inflated a room feels
     varies by room and by person. 30% doubles the shrink the old floor
     offered; the default stays 100%, the capture's own angular scale. */
  /* Where the room menu lives, in one place. The chip sits 22 degrees below
     the eye line — low enough not to cover the room, high enough to reach
     with a glance rather than a craned neck; the open list sits 8 degrees
     below, straight in comfortable view. Turning more than 50 degrees away
     from the chip brings it round to where the person now faces. */
  /* Both at the same height, a little under the eye line rather than down by
     the feet. The dot used to sit 22 degrees down and the list it opened 8
     degrees down — so a person lowered their head to reach the dot and the
     list then appeared ABOVE where they were now looking, out of reach of the
     gaze that had just opened it. Reported from the headset as a line of
     files you have to look at your own feet to summon and cannot then
     choose from. One height for both: the list appears exactly where the
     dot was. */
  const MENU_CHIP_PITCH = 0.26;
  /* The list stands as a column to the right, read top to bottom, rather
     than as a fan the head has to sweep along. A row of entries put the
     whole list at one height, so choosing meant swinging the head sideways
     across every other entry on the way — and the entries it swept over
     were the ones that kept choosing themselves. */
  /* Straight ahead. Set off to one side, the column could only be aimed at
     by turning the head far enough that the column left the view — reported
     from the headset as having to turn ninety degrees and then not being
     able to see the thing being aimed at. A list stands in front of the
     person who asked for it. */
  const MENU_COLUMN_YAW = 0;
  const MENU_ROW_PITCH = 0.22;
  /* A column of rows is only a column while it fits in front of a person.
     Twelve rooms would stand seventy degrees tall — a wall, not a list — so
     the column is a window on the rooms rather than all of them: the one you
     are in, its neighbours, and the way out. A building with floors wants
     grouping by floor, and that is the answer when it arrives; a silent
     seventy-degree wall is not. */
  const MENU_MAX_ROOM_ROWS = 4;
  /* Past the top row or past the bottom one, the column scrolls. Holding a
     look there keeps it moving, a row at a time, so a list longer than the
     window is reachable without a controller and without hiding anything.
     A building with floors will still want grouping by floor; this is what
     makes the plain list honest until then. */
  const MENU_SCROLL_SECONDS = 0.5;
  const MENU_SCROLL_ZONE = 0.30;
  /* Panels stand in the room, at a place, not at a direction from the head.
     Hung on a direction they travel with the person: step sideways and the
     list steps with you, which is the difference between a heads-up display
     and a browser window in a room. Asked for in exactly those words — the
     window stays, the keyboard stays, and you walk around them. */
  const PANEL_DISTANCE = 2.4;
  /* It can never be lost, though: turn right round, or walk out of the room
     it was left in, and it comes to where you now are. */
  const PANEL_RECENTRE_ANGLE = 2.2;
  const PANEL_RECENTRE_METRES = 4.0;
  /* Wide across, narrow up and down: every entry shares one yaw, so
     sideways precision buys nothing, and it is the vertical distance that
     has to tell one row from the next. */
  const MENU_CHIP_CATCH = 0.13;
  const MENU_ROW_YAW_CATCH = 0.26;
  const MENU_ROW_PITCH_CATCH = 0.10;
  /* The menu stays where it was left. It only comes back around when the
     person has turned so far that it is behind them — anything tighter and
     it teleports in front of the eyes on every glance, which is exactly what
     the headset reported: "however you move your head, it runs with you". */
  const MENU_HOLD_ANGLE = 2.2;
  /* Holding a look is the way in. Reported twice from the headset: pinches
     do not reach this page on that device — not for pins, not for the menu.
     A gaze needs no controller, no hand tracking and no permission. */
  const DWELL_SECONDS = 0.9;
  /* An entry in the list asks for longer than the dot does. The dot is a
     deliberate act — you went looking for it; an entry is a thing the gaze
     can simply land on while reading the list, and landing is not choosing. */
  const ITEM_DWELL_SECONDS = 1.4;
  /* And a hold only counts while the head is actually still. A gaze crossing
     a target at speed is passing over it, not resting on it — which is
     exactly what "my eye fell on a room and it opened" describes. Degrees
     per second, generous enough for the small drift nobody can suppress. */
  const STEADY_DEGREES_PER_SECOND = 14;
  const MENU_CHIP_COS = Math.cos(MENU_CHIP_PITCH);
  const MENU_CHIP_SIN = Math.sin(MENU_CHIP_PITCH);

  const SIZE_MIN = 30;
  const SIZE_MAX = 100;

  /* The number on the slider is a felt size, delivered as a distance: below
     100% the sphere is drawn at a finite radius around the head and each eye
     at its true offset, so stereo disparity — the cue the brain actually
     uses — says how far the walls are. 50% puts them at two metres; 100% is
     the capture as shot, at infinity. Angles are never distorted at any
     setting. */
  const sizeToRadius = (size) => (size >= 100 ? 0 : size * 0.04);

  function rememberedRoomSize() {
    try {
      const stored = Number(window.localStorage?.getItem(SIZE_KEY));
      if (Number.isFinite(stored) && stored >= SIZE_MIN && stored <= SIZE_MAX) return stored;
    } catch (_) { /* private browsing; the default is fine */ }
    return 100;
  }

  function rememberRoomSize(size) {
    try { window.localStorage?.setItem(SIZE_KEY, String(size)); } catch (_) { /* nothing to do */ }
  }

  /* Asked once, and only ever answered by the device. */
  let immersiveOffered = null;
  async function headsetCanDoThis() {
    if (immersiveOffered !== null) return immersiveOffered;
    try {
      immersiveOffered = Boolean(navigator.xr && await navigator.xr.isSessionSupported("immersive-vr"));
    } catch (_) {
      immersiveOffered = false;
    }
    return immersiveOffered;
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compilation failed");
    }
    return shader;
  }

  function startSphere(initialMedia, initialIsVideo, onFrame, onVRChange) {
    /* Mutable on purpose: choosing another room from inside the headset
       replaces what the sphere samples without ending the XR session —
       taking the headset off to change rooms is a dead end. */
    let media = initialMedia;
    let isVideo = initialIsVideo;
    const canvas = document.createElement("canvas");
    stage.appendChild(canvas);
    /* xrCompatible from the start, exactly as the headset probe asked for it.
       Asking an existing context to become XR compatible afterwards is allowed
       to lose and restore it, and a restored context has no program, no buffer
       and no texture — which looks from the outside like a button that does
       nothing. Browsers with no WebXR ignore the attribute. */
    const attributes = { antialias: false, alpha: false, xrCompatible: true };
    /* WebGL 2 first, which is what the headset probe used and what worked in
       the headset. The shaders are ES 1.00 and a WebGL 2 context accepts them
       unchanged, so this costs nothing and removes the last difference between
       the page that opened an immersive session and the one that would not. */
    const gl =
      canvas.getContext("webgl2", attributes) ||
      canvas.getContext("webgl", attributes) ||
      canvas.getContext("experimental-webgl", attributes);
    if (!gl) throw new Error("WebGL unavailable");

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

    /* A 5.7K equirectangular frame seen through a headset puts many texels
       under every screen pixel, and the room-size remap compresses them
       further. Sampled with plain LINEAR that undersampling shimmers on
       every head turn — the room reads as rippling water. WebGL 2 allows
       mipmaps on any size, so there the texture gets a proper pyramid and
       trilinear + anisotropic sampling; WebGL 1 forbids NPOT mipmaps and
       keeps the old filter. */
    const isWebGL2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, isWebGL2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (isWebGL2) {
      const anisotropy = gl.getExtension("EXT_texture_filter_anisotropic");
      if (anisotropy) {
        const maxAnisotropy = gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAnisotropy));
      }
    }
    /* An equirectangular frame stores the zenith in its first row, and the
       shader samples it that way: v = 0 is straight up. Flipping the upload
       turned the sphere over — looking up showed the floor. */
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

    const uniforms = {
      yaw: gl.getUniformLocation(program, "yaw"),
      pitch: gl.getUniformLocation(program, "pitch"),
      tanHalfFov: gl.getUniformLocation(program, "tanHalfFov"),
      aspect: gl.getUniformLocation(program, "aspect"),
    };

    const view = { yaw: 0, pitch: 0, fov: 1.4 };
    const state = { alive: true, dragging: false, gyro: false, frame: 0, textureReady: false, videoFrameDirty: true, uploadedTime: -1 };

    /* The render loop runs at headset rate, the video at its own — most
       frames the pixels have not changed and re-uploading them (and
       rebuilding the mip pyramid) is pure waste. The browser says when a
       real new frame exists; where it cannot, the clock stands in. */
    let frameCallbackSupported = false;
    function watchVideoFrames() {
      frameCallbackSupported = isVideo && typeof media.requestVideoFrameCallback === "function";
      if (!frameCallbackSupported) return;
      const watched = media;
      const noteVideoFrame = () => {
        /* The room may have been swapped mid-chain; a stale element's frames
           must neither dirty the texture nor keep an orphan loop alive. */
        if (!state.alive || watched !== media) return;
        state.videoFrameDirty = true;
        watched.requestVideoFrameCallback(noteVideoFrame);
      };
      watched.requestVideoFrameCallback(noteVideoFrame);
    }
    watchVideoFrames();

    function setMedia(nextMedia, nextIsVideo) {
      if (isVideo) media.pause?.();
      media = nextMedia;
      isVideo = Boolean(nextIsVideo);
      state.textureReady = false;
      state.videoFrameDirty = true;
      state.uploadedTime = -1;
      watchVideoFrames();
    }

    function resize() {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(stage.clientWidth * ratio));
      const height = Math.max(1, Math.round(stage.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        gl.viewport(0, 0, width, height);
      }
    }

    function uploadTexture() {
      const ready = isVideo ? media.readyState >= 2 : media.complete && media.naturalWidth > 0;
      if (!ready) return;
      if (isVideo && state.textureReady) {
        if (frameCallbackSupported) {
          if (!state.videoFrameDirty) return;
        } else if (media.currentTime === state.uploadedTime) return;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, media);
      if (isWebGL2) gl.generateMipmap(gl.TEXTURE_2D);
      state.videoFrameDirty = false;
      state.uploadedTime = isVideo ? media.currentTime : 0;
      state.textureReady = true;
    }

    function draw() {
      if (!state.alive) return;
      state.frame = window.requestAnimationFrame(draw);
      resize();
      if (isVideo || !state.textureReady) uploadTexture();
      if (!state.textureReady) return;
      /* Named rather than assumed: the immersive path links a second program,
         and uniforms set against whichever one happens to be current is a bug
         that only appears after somebody has used the headset once. */
      gl.useProgram(program);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1f(uniforms.yaw, view.yaw);
      gl.uniform1f(uniforms.pitch, view.pitch);
      gl.uniform1f(uniforms.tanHalfFov, Math.tan(view.fov / 2));
      const aspect = canvas.width / Math.max(1, canvas.height);
      gl.uniform1f(uniforms.aspect, aspect);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // The marker layer is positioned from the very same view the shader just
      // drew, in the same frame, so a pin can never lag the sphere by a frame.
      onFrame?.({ yaw: view.yaw, pitch: view.pitch, fov: view.fov, aspect });
    }

    /* Standing in the room rather than looking at it.
       Built lazily, on the same context and against the same texture, so a
       playing capture keeps playing when the headset takes over. */
    let xr = null;

    /* Held out here rather than inside the session, because the list and the
       preference are both set from the flat viewer long before anybody reaches
       for the headset. Kept inside, a marker placed on a laptop would simply
       not be in the room. */
    let headsetMarkerSource = [];
    let headsetMarkers = [];
    let headsetRadius = 0;

    let onMarkerChosen = null;
    function whenMarkerChosen(handler) { onMarkerChosen = handler; }

    /* The other rooms of the same project, reachable from inside the headset.
       A person standing in the Family Room asking "now show me the Dining
       Room" must not have to take the headset off to answer it. */
    let headsetRooms = [];
    let onRoomChosen = null;
    function whenRoomChosen(handler) { onRoomChosen = handler; }

    function bakeLabelTexture(text, current) {
      const board = document.createElement("canvas");
      board.width = 512;
      board.height = 96;
      const ink = board.getContext("2d");
      ink.clearRect(0, 0, 512, 96);
      ink.fillStyle = "rgba(7, 20, 33, 0.9)";
      ink.strokeStyle = current ? "rgba(72, 211, 232, 0.9)" : "rgba(255, 255, 255, 0.28)";
      ink.lineWidth = 3;
      const round = 22;
      ink.beginPath();
      ink.moveTo(round, 2);
      ink.arcTo(510, 2, 510, 94, round);
      ink.arcTo(510, 94, 2, 94, round);
      ink.arcTo(2, 94, 2, 2, round);
      ink.arcTo(2, 2, 510, 2, round);
      ink.closePath();
      ink.fill();
      ink.stroke();
      ink.textAlign = "center";
      ink.textBaseline = "middle";
      ink.fillStyle = current ? "#8ce8f3" : "#edf5f7";
      const shown = String(text || "");
      /* Shrink the lettering to fit before shortening the words: a room
         called "Primary bathroom, second floor" should read as itself, not
         as an ellipsis. Only past the smallest legible size is it cut. */
      let size = 40;
      ink.font = `600 ${size}px Inter, system-ui, sans-serif`;
      while (size > 26 && ink.measureText(shown).width > 452) {
        size -= 2;
        ink.font = `600 ${size}px Inter, system-ui, sans-serif`;
      }
      let fitted = shown;
      while (fitted.length > 4 && ink.measureText(fitted).width > 452) fitted = `${fitted.slice(0, -2).trimEnd()}…`;
      ink.fillText(fitted, 256, 50);
      const baked = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, baked);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
      return baked;
    }

    /* What the pin says once it is chosen, drawn as a texture because inside
       an immersive session there is no DOM to draw it in. The evidence card
       the flat viewer opens is HTML — perfectly good on a laptop, and
       completely invisible to somebody wearing the headset. That is why
       choosing a pin in VR appeared to do nothing at all even after the
       gesture worked: the answer was being rendered where nobody could see
       it. This is the same content, drawn into the room. */
    function bakePanelTexture(marker) {
      const board = document.createElement("canvas");
      board.width = 768;
      board.height = 432;
      const ink = board.getContext("2d");
      ink.clearRect(0, 0, 768, 432);
      ink.fillStyle = "rgba(6, 17, 28, 0.94)";
      ink.strokeStyle = marker.confirmed ? "rgba(128, 214, 169, 0.85)" : "rgba(255, 207, 153, 0.85)";
      ink.lineWidth = 4;
      const round = 26;
      ink.beginPath();
      ink.moveTo(round, 3);
      ink.arcTo(765, 3, 765, 429, round);
      ink.arcTo(765, 429, 3, 429, round);
      ink.arcTo(3, 429, 3, 3, round);
      ink.arcTo(3, 3, 765, 3, round);
      ink.closePath();
      ink.fill();
      ink.stroke();

      /* The standing first, and in its own colour. A reading the AI made and
         a value a person confirmed must never look alike — least of all here,
         where somebody is standing in the room believing what they see. */
      const standing = String(marker.standing || "Read by AI · not confirmed");
      ink.textAlign = "left";
      ink.textBaseline = "middle";
      ink.font = "600 26px Inter, system-ui, sans-serif";
      const chipWidth = Math.min(560, ink.measureText(standing).width + 40);
      ink.fillStyle = marker.confirmed ? "rgba(80, 214, 148, 0.16)" : "rgba(255, 187, 120, 0.16)";
      ink.beginPath();
      ink.moveTo(50, 38);
      ink.arcTo(42 + chipWidth, 38, 42 + chipWidth, 90, 16);
      ink.arcTo(42 + chipWidth, 90, 42, 90, 16);
      ink.arcTo(42, 90, 42, 38, 16);
      ink.arcTo(42, 38, 42 + chipWidth, 38, 16);
      ink.closePath();
      ink.fill();
      ink.fillStyle = marker.confirmed ? "#7fe0ad" : "#ffcf99";
      ink.fillText(standing, 62, 65);

      /* The title, shrunk to fit and wrapped over two lines before anything
         is cut: a marked point called "Panel schedule mismatch, north wall"
         should read as itself. */
      const words = String(marker.label || "Marked point").split(/\s+/);
      let size = 46;
      ink.font = `700 ${size}px Inter, system-ui, sans-serif`;
      const lines = [];
      let line = "";
      for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (ink.measureText(candidate).width > 668 && line) { lines.push(line); line = word; }
        else line = candidate;
        if (lines.length === 2) break;
      }
      if (line && lines.length < 2) lines.push(line);
      ink.fillStyle = "#eef6f9";
      lines.slice(0, 2).forEach((text, index) => {
        let fitted = text;
        while (fitted.length > 4 && ink.measureText(fitted).width > 668) fitted = `${fitted.slice(0, -2).trimEnd()}…`;
        ink.fillText(fitted, 46, 150 + index * 56);
      });

      ink.font = "400 27px Inter, system-ui, sans-serif";
      ink.fillStyle = "#a8bccb";
      const rows = [
        marker.detail || "",
        marker.source ? `Seen in ${marker.source}` : "",
      ].filter(Boolean);
      rows.slice(0, 2).forEach((text, index) => {
        let fitted = text;
        while (fitted.length > 4 && ink.measureText(fitted).width > 668) fitted = `${fitted.slice(0, -2).trimEnd()}…`;
        ink.fillText(fitted, 46, 272 + index * 42);
      });

      /* The refusal, printed where the temptation is. A confirmation is a
         person putting their name on a value; a held glance is not that, and
         a headset that let a stare confirm a reading would launder provenance
         by accident — the one failure this product exists to refuse. */
      ink.font = "500 23px Inter, system-ui, sans-serif";
      ink.fillStyle = "#7c93a5";
      ink.fillText("A verdict is not given by a glance — confirm it on the screen.", 46, 392);

      const baked = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, baked);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
      return baked;
    }

    /* The way in is a dot, not a signboard. A banner the width of a door
       sat in the middle of the room and was, in the headset's own words,
       annoying; the menu it opens is the thing worth showing, and only
       once it is asked for. */
    function bakeDotTexture() {
      const board = document.createElement("canvas");
      board.width = 128;
      board.height = 128;
      const ink = board.getContext("2d");
      ink.clearRect(0, 0, 128, 128);
      ink.beginPath();
      ink.arc(64, 64, 40, 0, Math.PI * 2);
      ink.fillStyle = "rgba(7, 20, 33, 0.82)";
      ink.fill();
      ink.lineWidth = 8;
      ink.strokeStyle = "rgba(140, 232, 243, 0.95)";
      ink.stroke();
      ink.beginPath();
      ink.arc(64, 64, 13, 0, Math.PI * 2);
      ink.fillStyle = "rgba(140, 232, 243, 0.95)";
      ink.fill();
      const baked = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, baked);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
      return baked;
    }


    /* The way out of a pin's answer. Its own texture rather than the menu's
       dot: the same shape for "open the rooms" and "close this" is a riddle,
       and a panel whose exit is a riddle is a dead end with a view. */
    function bakeCloseTexture() {
      const board = document.createElement("canvas");
      board.width = 128;
      board.height = 128;
      const ink = board.getContext("2d");
      ink.clearRect(0, 0, 128, 128);
      ink.beginPath();
      ink.arc(64, 64, 40, 0, Math.PI * 2);
      ink.fillStyle = "rgba(7, 20, 33, 0.86)";
      ink.fill();
      ink.lineWidth = 8;
      ink.strokeStyle = "rgba(200, 224, 236, 0.95)";
      ink.stroke();
      ink.lineWidth = 11;
      ink.lineCap = "round";
      ink.strokeStyle = "rgba(226, 240, 247, 0.98)";
      ink.beginPath();
      ink.moveTo(48, 48); ink.lineTo(80, 80);
      ink.moveTo(80, 48); ink.lineTo(48, 80);
      ink.stroke();
      const baked = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, baked);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, board);
      return baked;
    }

    function rebuildRoomMenu() {
      if (!xr) return;
      const menu = xr.menu;
      for (const item of menu.items) gl.deleteTexture(item.texture);
      if (menu.chipTexture) gl.deleteTexture(menu.chipTexture);
      /* The window on the rooms: where the person scrolled it to, held
         within the list rather than allowed to run off either end. */
      const lastStart = Math.max(0, headsetRooms.length - MENU_MAX_ROOM_ROWS);
      const from = Math.max(0, Math.min(lastStart, menu.offset || 0));
      menu.offset = from;
      menu.moreAbove = from;
      menu.moreBelow = Math.max(0, headsetRooms.length - MENU_MAX_ROOM_ROWS - from);
      menu.rowsPlaced = false;
      menu.items = headsetRooms.slice(from, from + MENU_MAX_ROOM_ROWS).map((room) => ({
        id: room.id,
        current: Boolean(room.current),
        texture: bakeLabelTexture(room.current ? `● ${room.title}` : room.title, Boolean(room.current)),
        dir: [0, -1, 0],
      }));
      /* The way out rides in the same list, at the TOP of it. A person who
         can walk to any room from inside the headset must be able to walk
         back to the screen the same way — but the most final thing in the
         list must not be the row the aim happens to land on when the list
         opens, and the list opens where the dot was, below. */
      menu.items.unshift({
        id: "__exit-vr",
        exit: true,
        current: false,
        texture: bakeLabelTexture("◉ Back to the screen", false),
        dir: [0, -1, 0],
      });
      menu.chipTexture = bakeDotTexture();
      /* Only where something is actually there to reach. */
      if (menu.upTexture) gl.deleteTexture(menu.upTexture);
      if (menu.downTexture) gl.deleteTexture(menu.downTexture);
      menu.upTexture = menu.moreAbove > 0
        ? bakeLabelTexture(`▲ ${menu.moreAbove} more`, false) : null;
      menu.downTexture = menu.moreBelow > 0
        ? bakeLabelTexture(`▼ ${menu.moreBelow} more`, false) : null;
    }

    function setHeadsetRooms(list) {
      headsetRooms = (Array.isArray(list) ? list : [])
        .filter((room) => room && room.id && room.title)
        /* The eight-room cap existed because the list was one fan across the
           view and a ninth room had nowhere to go. A column that scrolls has
           somewhere to put them; only the visible window is ever baked, so
           the length costs nothing. */
        .slice(0, 200);
      rebuildRoomMenu();
      return headsetRooms.length;
    }

    async function enterVR() {
      if (xr?.session) return { ok: true, already: true };
      if (!navigator.xr) return { ok: false, why: "This browser cannot open an immersive view." };
      let xrSession;
      try {
        xrSession = await navigator.xr.requestSession("immersive-vr", {
          optionalFeatures: ["local-floor"],
        });
      } catch (error) {
        /* The name and message the device gave. A generic sentence here is what
           turns a fixable problem into an afternoon. */
        return {
          ok: false,
          why: `The headset refused to open an immersive view — ${error.name || "error"}: ${error.message || error}`,
        };
      }
      try {
        /* Already asked for at creation; this is the belt to that pair of
           braces, and a no-op when the context is compatible. */
        if (gl.makeXRCompatible) await gl.makeXRCompatible();
        const program2 = gl.createProgram();
        gl.attachShader(program2, compile(gl, gl.VERTEX_SHADER, XR_VERTEX_SHADER));
        gl.attachShader(program2, compile(gl, gl.FRAGMENT_SHADER, XR_FRAGMENT_SHADER));
        gl.linkProgram(program2);
        if (!gl.getProgramParameter(program2, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(program2) || "XR program link failed");
        }
        const xrUniforms = {
          invProjection: gl.getUniformLocation(program2, "invProjection"),
          viewRotation: gl.getUniformLocation(program2, "viewRotation"),
          eyeOffset: gl.getUniformLocation(program2, "eyeOffset"),
          sphereRadius: gl.getUniformLocation(program2, "sphereRadius"),
        };

        /* The pins, in the room rather than on a pane in front of it. */
        const markerProgram = gl.createProgram();
        gl.attachShader(markerProgram, compile(gl, gl.VERTEX_SHADER, MARKER_VERTEX_SHADER));
        gl.attachShader(markerProgram, compile(gl, gl.FRAGMENT_SHADER, MARKER_FRAGMENT_SHADER));
        gl.linkProgram(markerProgram);
        if (!gl.getProgramParameter(markerProgram, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(markerProgram) || "Marker program link failed");
        }
        const markerUniforms = {
          projection: gl.getUniformLocation(markerProgram, "projection"),
          viewRotationInverse: gl.getUniformLocation(markerProgram, "viewRotationInverse"),
          markerDirection: gl.getUniformLocation(markerProgram, "markerDirection"),
          markerSize: gl.getUniformLocation(markerProgram, "markerSize"),
          markerColour: gl.getUniformLocation(markerProgram, "markerColour"),
          looking: gl.getUniformLocation(markerProgram, "looking"),
          reticle: gl.getUniformLocation(markerProgram, "reticle"),
          markerDistance: gl.getUniformLocation(markerProgram, "markerDistance"),
          eyeOffset: gl.getUniformLocation(markerProgram, "eyeOffset"),
        };
        const markerCorner = gl.getAttribLocation(markerProgram, "corner");
        const markerQuad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, markerQuad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 1, -1, -1, 1,
          -1, 1, 1, -1, 1, 1,
        ]), gl.STATIC_DRAW);
        const xrPosition = gl.getAttribLocation(program2, "position");

        /* The room menu's words, on the same quad geometry the pins use. */
        const labelProgram = gl.createProgram();
        gl.attachShader(labelProgram, compile(gl, gl.VERTEX_SHADER, LABEL_VERTEX_SHADER));
        gl.attachShader(labelProgram, compile(gl, gl.FRAGMENT_SHADER, LABEL_FRAGMENT_SHADER));
        gl.linkProgram(labelProgram);
        if (!gl.getProgramParameter(labelProgram, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(labelProgram) || "Label program link failed");
        }
        const labelUniforms = {
          projection: gl.getUniformLocation(labelProgram, "projection"),
          viewRotationInverse: gl.getUniformLocation(labelProgram, "viewRotationInverse"),
          labelDirection: gl.getUniformLocation(labelProgram, "labelDirection"),
          labelSize: gl.getUniformLocation(labelProgram, "labelSize"),
          label: gl.getUniformLocation(labelProgram, "label"),
          looking: gl.getUniformLocation(labelProgram, "looking"),
          dwell: gl.getUniformLocation(labelProgram, "dwell"),
          room: gl.getUniformLocation(labelProgram, "room"),
          glass: gl.getUniformLocation(labelProgram, "glass"),
          labelDistance: gl.getUniformLocation(labelProgram, "labelDistance"),
          eyeOffset: gl.getUniformLocation(labelProgram, "eyeOffset"),
        };
        const labelCorner = gl.getAttribLocation(labelProgram, "corner");

        xrSession.updateRenderState({ baseLayer: new XRWebGLLayer(xrSession, gl) });
        let reference = null;
        for (const kind of ["local-floor", "local", "viewer"]) {
          try { reference = await xrSession.requestReferenceSpace(kind); break; } catch (_) { /* try the next */ }
        }
        if (!reference) throw new Error("no reference space");

        xr = {
          session: xrSession, reference, program2, xrUniforms, xrPosition, views: 0,
          markers: headsetMarkers, looking: null, forward: [0, 0, -1],
          /* 0 is the capture as shot, at infinity — where it starts. A
             positive radius is somebody's preference about how far the
             walls should feel. */
          sphereRadius: headsetRadius,
          menu: { open: false, items: [], chipTexture: null, chipDir: [0, -1, 0], heading: null, lookingChip: false, lookingItem: null, approach: 0, dwellOn: null, dwell: 0, dwellFired: false, armed: false,
            offset: 0, moreAbove: 0, moreBelow: 0, scrolling: 0, scrollHeld: 0, upTexture: null, downTexture: null, arrivedOn: null, justOpened: false,
            anchor: null, origin: null, chipDistance: PANEL_DISTANCE, rowsPlaced: false },
          /* What a chosen pin says, parked in the room in front of whoever
             chose it. Empty until somebody holds a look on a pin. */
          panel: { markerId: null, texture: null, closeTexture: null, lines: [], dir: [0, 0, -1], closeDir: [0, -0.3, -0.95], lookingClose: false,
            world: null, closeWorld: null, distance: PANEL_DISTANCE, closeDistance: PANEL_DISTANCE },
        };
        rebuildRoomMenu();
        /* Test hooks: the lazy remap centre, the pin list, and the room menu —
           each observable and drivable without a headset, so what only runs
           inside one can still be proven on a machine that has none. */
        window.__xrAnchor = () => xr?.anchor || null;
        window.__xrForward = () => (xr ? xr.forward.slice() : null);
        window.__xrSetMarkers = (list) => setHeadsetMarkers(list || []);
        window.__xrSetRooms = (list) => setHeadsetRooms(list || []);
        window.__xrMenu = () => (xr ? {
          open: xr.menu.open,
          chipDir: xr.menu.chipDir.slice(),
          heading: xr.menu.heading ? xr.menu.heading.slice() : null,
          items: xr.menu.items.map((item) => ({ id: item.id, dir: item.dir.slice(), current: item.current, exit: Boolean(item.exit) })),
          lookingChip: xr.menu.lookingChip,
          lookingItem: xr.menu.lookingItem?.id || null,
          offset: xr.menu.offset,
          moreAbove: xr.menu.moreAbove,
          moreBelow: xr.menu.moreBelow,
          scrolling: xr.menu.scrolling,
          dwellOn: xr.menu.dwellOn,
          dwell: xr.menu.dwell,
          armed: xr.menu.armed,
        } : null);
        window.__xrPanel = () => (xr?.panel.markerId ? {
          markerId: xr.panel.markerId,
          dir: xr.panel.dir.slice(),
          closeDir: xr.panel.closeDir.slice(),
          lookingClose: xr.panel.lookingClose,
          lines: xr.panel.lines.slice(),
        } : null);

        /* One place where choosing happens, however it was asked for: a
           held gaze, a pinch, a controller trigger, a grip. The menu owns
           the choice while it is on screen; otherwise the pin somebody is
           looking at opens, which is the whole point of putting pins in the
           room. */
        /* A pin's answer, parked where the person was looking when they chose
           it, with its own way out. Drawn in the room because the room is
           where they are. */
        function openHeadsetPanel(marker) {
          const panel = xr.panel;
          if (panel.texture) gl.deleteTexture(panel.texture);
          panel.markerId = marker.id;
          panel.texture = bakePanelTexture(marker);
          if (!panel.closeTexture) panel.closeTexture = bakeCloseTexture();
          panel.lines = [marker.standing || "Read by AI · not confirmed", marker.label || "Marked point",
            marker.detail || "", marker.source ? `Seen in ${marker.source}` : ""].filter(Boolean);
          /* Put where the person was standing when they chose the pin, and
             left there: a card that travels with the head is a card nobody
             can step around to read. */
          const forward = xr.forward;
          const head = xr.headPosition || { x: 0, y: 0, z: 0 };
          const under = [forward[0], forward[1] - 0.34, forward[2]];
          const length = Math.hypot(under[0], under[1], under[2]) || 1;
          panel.world = {
            x: head.x + forward[0] * PANEL_DISTANCE,
            y: head.y + forward[1] * PANEL_DISTANCE,
            z: head.z + forward[2] * PANEL_DISTANCE,
          };
          panel.closeWorld = {
            x: head.x + (under[0] / length) * PANEL_DISTANCE,
            y: head.y + (under[1] / length) * PANEL_DISTANCE,
            z: head.z + (under[2] / length) * PANEL_DISTANCE,
          };
          panel.dir = [forward[0], forward[1], forward[2]];
          panel.closeDir = [under[0] / length, under[1] / length, under[2] / length];
          panel.distance = PANEL_DISTANCE;
          panel.closeDistance = PANEL_DISTANCE;
          panel.lookingClose = false;
        }

        function closeHeadsetPanel() {
          const panel = xr?.panel;
          if (!panel?.markerId) return false;
          if (panel.texture) gl.deleteTexture(panel.texture);
          panel.texture = null;
          panel.markerId = null;
          panel.lines = [];
          panel.lookingClose = false;
          return true;
        }

        function chooseWhatIsLookedAt() {
          const panel = xr?.panel;
          /* While a pin's answer is up it owns the gaze: the only thing to
             choose is the way out of it. */
          if (panel?.markerId) {
            if (panel.lookingClose) closeHeadsetPanel();
            return true;
          }
          const menu = xr?.menu;
          if (menu?.items.length) {
            if (menu.lookingItem) {
              const chosen = menu.lookingItem;
              menu.open = false;
              if (chosen.exit) exitVR();
              else if (!chosen.current) onRoomChosen?.(chosen.id);
              return true;
            }
            if (menu.lookingChip) {
              menu.open = !menu.open;
              /* Opening lands the window on the room somebody is standing in;
                 after that the window is theirs to move. */
              if (menu.open) {
                const standing = headsetRooms.findIndex((room) => room.current);
                menu.offset = Math.max(0, (standing < 0 ? 0 : standing) - Math.floor(MENU_MAX_ROOM_ROWS / 2));
                rebuildRoomMenu();
              }
              /* The list opens where the dot was, so an item lands under the
                 gaze that just opened it — and it would start filling at
                 once. Reported from the headset as a file that switches
                 itself on while you are only looking. Nothing may be chosen
                 until the gaze has left every item once: arriving somewhere
                 is not choosing it. */
              menu.armed = false;
              /* Which row the aim lands on cannot be known yet: the rows are
                 judged against a list that was closed a moment ago, so
                 lookingItem is null here and "different from null" would arm
                 the trigger instantly. The next frame knows, and records it. */
              menu.justOpened = true;
              menu.arrivedOn = null;
              return true;
            }
            if (menu.open) {
              menu.open = false;
              return true;
            }
          }
          const marker = xr?.looking;
          if (!marker) return false;
          /* Both surfaces answer: the panel for the person in the headset,
             and the flat card for the same person the moment they take it
             off. Neither one is the other's substitute. */
          openHeadsetPanel(marker);
          onMarkerChosen?.(marker.id);
          return true;
        }
        xr.choose = chooseWhatIsLookedAt;
        xr.closePanel = closeHeadsetPanel;

        /* Where the DEVICE says the person is aiming.
         *
         * A crosshair carried on the head made every target something to be
         * chased, and on a headset that tracks eyes it is worse than useless:
         * the person is already looking at the thing they mean. Reported from
         * the headset in those words — nothing but crosshairs, and the room
         * behind them unseeable.
         *
         * WebXR hands the aim over when the device knows it. A pinch on a
         * headset with eye tracking raises a transient-pointer input source
         * whose ray IS the gaze; a controller or a tracked hand raises one
         * that points where it points. Read it, and there is nothing to
         * chase. Only when the device offers no pointer at all does the head
         * become the aim again, and only then is a crosshair drawn. */
        function rayOf(pose) {
          if (!pose) return null;
          const m = pose.transform.matrix;
          const position = pose.transform.position;
          return {
            origin: [position.x, position.y, position.z],
            /* -Z of the pose's own basis is the way it points. */
            dir: [-m[8], -m[9], -m[10]],
          };
        }

        /* Everything the aim can be on, judged from one ray.
         *
         * Split out of the frame loop because the frame is not the only
         * place aiming happens: a pinch on a headset that tracks eyes
         * arrives with its own ray, in its own frame, and that ray is where
         * the person was LOOKING. Judging it here means a pinch chooses what
         * the eyes were on, and the head is left to do nothing but carry
         * them — which is the whole difference between this and chasing a
         * crosshair around a room. */
        function aimEverything(ray) {
          if (!xr) return;
          const menu = xr.menu;
          const panel = xr.panel;
          const from = ray.origin;
          const length = Math.hypot(ray.dir[0], ray.dir[1], ray.dir[2]) || 1;
          const dir = [ray.dir[0] / length, ray.dir[1] / length, ray.dir[2] / length];
          /* Where a thing standing in the room is, seen from the aim's own
             origin — a controller in the hand is half a metre from the eye,
             and half a metre is twelve degrees at arm's reach. */
          const towards = (world) => {
            const dx = world.x - from[0];
            const dy = world.y - from[1];
            const dz = world.z - from[2];
            const span = Math.hypot(dx, dy, dz) || 0.0001;
            return [dx / span, dy / span, dz / span];
          };
          const alignment = (a) => a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2];

          let lookedItem = null;
          if (menu.items.length && !panel.markerId && menu.anchor) {
            if (menu.open) {
              const rowAim = menu.items.map((item) => ({ item, at: towards(item.world) }));
              const pitchOf = (v) => Math.asin(Math.max(-1, Math.min(1, -v[1])));
              const aimPitch = pitchOf(dir);
              const aimFlat = Math.hypot(dir[0], dir[2]) || 0.0001;
              /* A column is aimed at by height: wide across, because every
                 row shares one bearing, and narrow up and down, because that
                 is what tells one row from the next. */
              const columnAt = rowAim[0].at;
              const columnFlat = Math.hypot(columnAt[0], columnAt[2]) || 0.0001;
              const roundness = (columnAt[0] * dir[0] + columnAt[2] * dir[2]) / (columnFlat * aimFlat);
              const yawOff = Math.acos(Math.max(-1, Math.min(1, roundness)));
              if (yawOff < MENU_ROW_YAW_CATCH) {
                let bestRow = MENU_ROW_PITCH_CATCH;
                for (const row of rowAim) {
                  const off = Math.abs(pitchOf(row.at) - aimPitch);
                  if (off < bestRow) { bestRow = off; lookedItem = row.item; }
                }
                if (!lookedItem) {
                  const pitches = rowAim.map((row) => pitchOf(row.at));
                  const above = Math.min(...pitches) - aimPitch;
                  const below = aimPitch - Math.max(...pitches);
                  if (menu.moreAbove > 0 && above > MENU_ROW_PITCH_CATCH && above < MENU_SCROLL_ZONE) menu.scrolling = -1;
                  else if (menu.moreBelow > 0 && below > MENU_ROW_PITCH_CATCH && below < MENU_SCROLL_ZONE) menu.scrolling = 1;
                  else menu.scrolling = 0;
                } else {
                  menu.scrolling = 0;
                }
              } else {
                menu.scrolling = 0;
              }
            } else {
              menu.scrolling = 0;
            }
            menu.lookingItem = lookedItem;
            const chipAt = towards(menu.anchor);
            const chipDot = alignment(chipAt);
            /* Only while the list is down. Standing in front of the person,
               the column covers the ground the dot occupies, and a target
               nobody can see is not a target. With the list up, the way out
               is a row in the list. */
            menu.lookingChip = !menu.open && !lookedItem && chipDot > Math.cos(MENU_CHIP_CATCH);
            menu.approach = Math.max(0, Math.min(1,
              (chipDot - Math.cos(0.55)) / Math.max(0.0001, Math.cos(MENU_CHIP_CATCH) - Math.cos(0.55))));
          } else {
            menu.lookingChip = false;
            menu.lookingItem = null;
            menu.approach = 0;
            menu.scrolling = 0;
          }

          if (panel.markerId && panel.closeWorld) {
            panel.lookingClose = alignment(towards(panel.closeWorld)) > Math.cos(0.24);
          } else {
            panel.lookingClose = false;
          }

          /* Pins are on the wall of the capture, which is a direction rather
             than a place, so they are judged against the ray itself. */
          let onPin = null;
          if (!menu.open && !panel.markerId) {
            let best = Math.cos(0.16);
            for (const marker of xr.markers) {
              const dot = alignment(marker.dir);
              if (dot > best) { best = dot; onPin = marker; }
            }
            let approach = 0;
            for (const marker of xr.markers) {
              approach = Math.max(approach, Math.min(1,
                (alignment(marker.dir) - Math.cos(0.55)) / Math.max(0.0001, Math.cos(0.16) - Math.cos(0.55))));
            }
            xr.pinApproach = Math.max(0, approach);
          } else {
            xr.pinApproach = 0;
          }
          xr.looking = onPin;
        }

        function pointerFromFrame(frame) {
          for (const source of xrSession.inputSources || []) {
            if (!source?.targetRaySpace) continue;
            const ray = rayOf(frame.getPose(source.targetRaySpace, reference));
            if (ray) return ray;
          }
          return null;
        }

        /* Taking hold of a panel and putting it somewhere else.
         *
         * Asked for in the words that describe every spatial system worth
         * copying: bring the menu up, move it with your hands, put it on the
         * wall you want it on. A press that stays still is a choice; a press
         * that travels is a move. One gesture, told apart by whether the
         * hand went anywhere — which is how it works on a headset that has
         * no separate grab button either. */
        const GRAB_ANGLE = 0.06;
        function beginGrab(ray) {
          if (!xr || !ray) return;
          const menu = xr.menu;
          const panel = xr.panel;
          aimEverything(ray);
          const holding = panel.markerId && !panel.lookingClose ? "panel"
            : (menu.lookingChip || menu.open ? "menu" : null);
          xr.grab = holding ? { what: holding, from: ray.dir.slice(), moved: false } : null;
        }

        function continueGrab(ray) {
          const grab = xr?.grab;
          if (!grab || !ray) return;
          const was = grab.from;
          const now = ray.dir;
          const span = Math.hypot(now[0], now[1], now[2]) || 1;
          const dir = [now[0] / span, now[1] / span, now[2] / span];
          const turned = Math.acos(Math.max(-1, Math.min(1,
            was[0] * dir[0] + was[1] * dir[1] + was[2] * dir[2])));
          if (!grab.moved && turned < GRAB_ANGLE) return;
          grab.moved = true;
          /* Carried at the distance it was already standing at, so a panel
             does not fly towards or away from the person while being moved. */
          const menu = xr.menu;
          const panel = xr.panel;
          const carry = (world, distance) => ({
            x: ray.origin[0] + dir[0] * distance,
            y: ray.origin[1] + dir[1] * distance,
            z: ray.origin[2] + dir[2] * distance,
          });
          if (grab.what === "panel" && panel.world) {
            const before = panel.world;
            const moved = carry(before, panel.distance || PANEL_DISTANCE);
            const shift = [moved.x - before.x, moved.y - before.y, moved.z - before.z];
            panel.world = moved;
            panel.closeWorld = {
              x: panel.closeWorld.x + shift[0],
              y: panel.closeWorld.y + shift[1],
              z: panel.closeWorld.z + shift[2],
            };
          } else if (grab.what === "menu" && menu.anchor) {
            const before = menu.anchor;
            const moved = carry(before, menu.chipDistance || PANEL_DISTANCE);
            const shift = [moved.x - before.x, moved.y - before.y, moved.z - before.z];
            menu.anchor = moved;
            /* The rows are placed against the same origin, so the whole
               assembly travels as one thing rather than coming apart. */
            menu.origin = {
              x: menu.origin.x + shift[0],
              y: menu.origin.y + shift[1],
              z: menu.origin.z + shift[2],
            };
            menu.rowsPlaced = false;
          }
          grab.from = dir;
        }

        /* Devices disagree about which gesture they report — a pinch, a
           trigger, a grip — so both completion events are heard. Only the
           completion ones: pairing these with their *start twins would fire
           twice for a single deliberate press held for a moment. A short
           guard collapses a device that reports both at once. */
        let lastChoice = 0;
        const chooseOnce = (event) => {
          const now = performance.now();
          if (now - lastChoice < 150) return;
          lastChoice = now;
          /* The event carries the frame it happened in, which is the only
             place a transient pointer exists: on a headset that tracks eyes
             the source appears with the pinch and is gone after it. Aim from
             it, so a pinch chooses what the EYES were on rather than what
             the head happened to face. */
          const ray = event?.inputSource?.targetRaySpace && event.frame
            ? rayOf(event.frame.getPose(event.inputSource.targetRaySpace, reference))
            : null;
          if (ray && xr) {
            xr.pointer = ray;
            xr.pointerIsDevice = true;
            aimEverything(ray);
          }
          /* A press that travelled was a move, and a move is not a choice. */
          if (xr?.grab?.moved) return;
          chooseWhatIsLookedAt();
        };
        for (const name of ["select", "squeeze"]) {
          xrSession.addEventListener(name, chooseOnce);
        }
        const rayOfEvent = (event) => (event?.inputSource?.targetRaySpace && event.frame
          ? rayOf(event.frame.getPose(event.inputSource.targetRaySpace, reference))
          : null);
        for (const name of ["selectstart", "squeezestart"]) {
          xrSession.addEventListener(name, (event) => beginGrab(rayOfEvent(event)));
        }
        for (const name of ["selectend", "squeezeend"]) {
          xrSession.addEventListener(name, () => { if (xr) xr.grab = null; });
        }

        xrSession.requestAnimationFrame(function xrFrame(time, frame) {
          if (!xr?.session) return;
          xrSession.requestAnimationFrame(xrFrame);
          /* The capture is a video, so the texture has to be refreshed here as
             well — the flat loop is not running while the headset is. */
          if (isVideo || !state.textureReady) uploadTexture();
          if (!state.textureReady) return;
          const pose = frame.getViewerPose(reference);
          if (!pose) return;
          xr.views = pose.views.length;
          const layer = xrSession.renderState.baseLayer;
          gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
          gl.clearColor(0, 0, 0, 1);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.useProgram(program2);
          gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
          gl.enableVertexAttribArray(xrPosition);
          gl.vertexAttribPointer(xrPosition, 2, gl.FLOAT, false, 0, 0);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          /* Where the head is pointing — averaged across the eyes rather
             than taken from the left one. Headset lenses are canted
             outward by several degrees, so one eye's forward is not the
             head's: aim taken from it sits off to one side of where the
             person is actually looking, and a target they are staring
             straight at never lights up. */
          const forward = [0, 0, 0];
          for (const eyeView of pose.views) {
            const m = eyeView.transform.inverse.matrix;
            forward[0] -= m[2];
            forward[1] -= m[6];
            forward[2] -= m[10];
          }
          const forwardLength = Math.hypot(forward[0], forward[1], forward[2]) || 1;
          forward[0] /= forwardLength;
          forward[1] /= forwardLength;
          forward[2] /= forwardLength;
          xr.forward = forward;

          /* The image no longer needs a centre — nothing is warped any more,
             so the room is simply still. The lazy heading survives for one
             job only: parking the menu. Glued to the instantaneous gaze the
             chip would run from the eye reaching for it; nailed to a compass
             point it would sit behind the person half the time. */
          const previousAnchor = xr.anchor || forward;
          const dt = Math.min(0.1, Math.max(1 / 90, (time - (xr.anchorTime || time)) / 1000));
          xr.anchorTime = time;
          const follow = 1 - Math.exp(-dt / 1.2);
          const blended = [
            previousAnchor[0] + (forward[0] - previousAnchor[0]) * follow,
            previousAnchor[1] + (forward[1] - previousAnchor[1]) * follow,
            previousAnchor[2] + (forward[2] - previousAnchor[2]) * follow,
          ];
          const anchorLength = Math.hypot(blended[0], blended[1], blended[2]) || 1;
          xr.anchor = [blended[0] / anchorLength, blended[1] / anchorLength, blended[2] / anchorLength];

          /* The chip waits a little below the eye line, in the direction the
             person is facing — and STOPS following the moment they turn
             towards it. Carried on the gaze it ran away from the eye reaching
             for it: chase it down far enough and the heading it was built
             from collapsed, so it flipped behind and overhead. Reported from
             the headset as "the word Rooms is on the ceiling and pinching
             does nothing". Frozen while looked at, and while the list is
             open, it is a thing in the room that can be aimed at. */
          /* The head's own position: everything below is placed against it
             once and then left alone, and each eye's offset is measured from
             the centre of the head rather than from the origin of whatever
             reference space the device handed back. */
          const headPosition = pose.transform?.position || { x: 0, y: 0, z: 0 };
          xr.headPosition = headPosition;
          /* Where a thing standing at a world point is from here, and how
             far — the two numbers the shaders want. */
          const aimAt = (world) => {
            const dx = world.x - headPosition.x;
            const dy = world.y - headPosition.y;
            const dz = world.z - headPosition.z;
            const length = Math.hypot(dx, dy, dz) || 0.0001;
            return { dir: [dx / length, dy / length, dz / length], distance: length };
          };
          const menu = xr.menu;
          const panel = xr.panel;
          if (menu.items.length && !panel.markerId) {
            /* Placed once, in the room, and then left where it was put.
               Only two things move it: turning right round, so it is behind
               you and unreachable, or walking out of the room it was left
               in. Both bring it to where you now are — it can be left, but
               it can never be lost. */
            const flat = Math.hypot(forward[0], forward[2]);
            const facing = flat > 0.35 ? [forward[0] / flat, forward[2] / flat] : (menu.heading || [0, -1]);
            let place = !menu.anchor;
            if (menu.anchor && !menu.open && !menu.lookingChip) {
              const standing = aimAt(menu.anchor);
              const behind = standing.dir[0] * forward[0] + standing.dir[1] * forward[1] + standing.dir[2] * forward[2]
                < Math.cos(PANEL_RECENTRE_ANGLE);
              if (behind || standing.distance > PANEL_RECENTRE_METRES) place = true;
            }
            if (place) {
              menu.heading = facing;
              const put = [facing[0] * MENU_CHIP_COS, -MENU_CHIP_SIN, facing[1] * MENU_CHIP_COS];
              menu.anchor = {
                x: headPosition.x + put[0] * PANEL_DISTANCE,
                y: headPosition.y + put[1] * PANEL_DISTANCE,
                z: headPosition.z + put[2] * PANEL_DISTANCE,
              };
              menu.origin = { x: headPosition.x, y: headPosition.y, z: headPosition.z };
              menu.rowsPlaced = false;
            }
            const standingAt = aimAt(menu.anchor);
            menu.chipDir = standingAt.dir;
            menu.chipDistance = standingAt.distance;

            /* One column, off to the right of where the person faced when it
               was placed, centred on the eye line — and standing at its own
               points in the room, so walking past it walks past it. */
            const heading = menu.heading;
            const turned = [
              heading[0] * Math.cos(-MENU_COLUMN_YAW) + heading[1] * Math.sin(-MENU_COLUMN_YAW),
              heading[1] * Math.cos(-MENU_COLUMN_YAW) - heading[0] * Math.sin(-MENU_COLUMN_YAW),
            ];
            if (!menu.rowsPlaced) {
              menu.items.forEach((item, index) => {
                const pitch = (index - (menu.items.length - 1) / 2) * MENU_ROW_PITCH;
                const flatScale = Math.cos(pitch);
                const rowDir = [turned[0] * flatScale, -Math.sin(pitch), turned[1] * flatScale];
                item.world = {
                  x: menu.origin.x + rowDir[0] * PANEL_DISTANCE,
                  y: menu.origin.y + rowDir[1] * PANEL_DISTANCE,
                  z: menu.origin.z + rowDir[2] * PANEL_DISTANCE,
                };
              });
              menu.rowsPlaced = true;
            }
            menu.items.forEach((item) => {
              const at = aimAt(item.world);
              item.dir = at.dir;
              item.distance = at.distance;
            });
            /* Aiming happens in aimEverything, from whatever ray the
               device gave us. Nothing is judged here. */
          }

          /* The ray the person is actually aiming with. A headset that
             tracks eyes hands one over on every pinch; a controller or a
             tracked hand hands one over continuously. Only when there is
             none does the head become the aim. */
          const devicePointer = pointerFromFrame(frame);
          xr.pointerIsDevice = Boolean(devicePointer);
          xr.pointer = devicePointer || {
            origin: [headPosition.x, headPosition.y, headPosition.z],
            dir: [forward[0], forward[1], forward[2]],
          };
          /* A press being held moves what it took hold of, before anything
             is judged: the aim follows the panel rather than the panel
             sliding out from under the aim. */
          if (devicePointer) continueGrab(devicePointer);
          aimEverything(xr.pointer);
          const looked = xr.looking;
          /* How close the aim is to the nearest pin, so a pin answers an
             approaching reticle exactly as the menu dot does. */
          let pinApproach = 0;
          if (!menu.open && !panel.markerId) {
            for (const marker of xr.markers) {
              const dot = marker.dir[0] * forward[0] + marker.dir[1] * forward[1] + marker.dir[2] * forward[2];
              pinApproach = Math.max(pinApproach, Math.min(1,
                (dot - Math.cos(0.55)) / Math.max(0.0001, Math.cos(0.16) - Math.cos(0.55))));
            }
          }
          xr.pinApproach = Math.max(0, pinApproach);
          /* Smoothed, because a number that flickers every frame cannot be
             read by somebody wearing the thing. */
          xr.fps = xr.fps ? xr.fps * 0.9 + (1 / dt) * 0.1 : 1 / dt;

          if (panel.markerId) {
            /* Read from where the person is now, not from where they were
               when they opened it. */
            if (panel.world) {
              const at = aimAt(panel.world);
              panel.dir = at.dir;
              panel.distance = at.distance;
              const closeAt = aimAt(panel.closeWorld);
              panel.closeDir = closeAt.dir;
              panel.closeDistance = closeAt.distance;
            }
            const closeDot = panel.closeDir[0] * forward[0] + panel.closeDir[1] * forward[1] + panel.closeDir[2] * forward[2];
            panel.lookingClose = closeDot > Math.cos(0.24);
          } else {
            panel.lookingClose = false;
          }

          /* Holding a look is choosing — of a menu item, of the way out, and
             of a pin in the room. The gaze must leave and come back before the
             same thing fires again, so opening the list does not instantly
             close it under a gaze that has not moved yet. */
          /* Armed by looking away from the list while the list is up. While
             it is down there is nothing to arm, and leaving the flag true
             across a close would hand the next opening a live trigger —
             which is exactly how a file chose itself: the list appeared
             under a gaze that was already armed from before it existed. */
          /* Armed by moving off whatever the aim happened to land on when
             the list appeared. Requiring the aim to leave the list entirely
             was too strict the moment the list stood in front of the person:
             moving straight from one row to another never passes through
             nothing, so nothing could ever be chosen. */
          if (!menu.open) { menu.armed = false; menu.arrivedOn = null; menu.justOpened = false; }
          else if (menu.justOpened) {
            /* The first frame with rows in it: whatever the aim is on now is
               where it arrived, and arriving is not choosing. */
            menu.arrivedOn = menu.lookingItem?.id || "__nothing";
            menu.justOpened = false;
            menu.armed = false;
          } else if (!menu.lookingItem || menu.lookingItem.id !== menu.arrivedOn) menu.armed = true;
          const dwellOn = (menu.armed ? menu.lookingItem?.id : null)
            || (menu.lookingChip ? "__chip" : null)
            || (panel.lookingClose ? "__panel-close" : null)
            || (looked ? `pin:${looked.id}` : null);
          if (dwellOn !== menu.dwellOn) {
            menu.dwellOn = dwellOn;
            menu.dwell = 0;
            menu.dwellFired = false;
          } else if (dwellOn && !menu.dwellFired) {
            /* How fast the head is turning right now. Held still, this is
               near zero; sweeping across the room it is tens of degrees a
               second, and nothing fills. */
            const previous = xr.lastForward || forward;
            const alignment = Math.max(-1, Math.min(1,
              previous[0] * forward[0] + previous[1] * forward[1] + previous[2] * forward[2]));
            const turnRate = (Math.acos(alignment) * 57.3) / Math.max(dt, 0.0001);
            const seconds = menu.lookingItem ? ITEM_DWELL_SECONDS : DWELL_SECONDS;
            if (turnRate < STEADY_DEGREES_PER_SECOND) menu.dwell = Math.min(1, menu.dwell + dt / seconds);
            if (menu.dwell >= 1) {
              menu.dwellFired = true;
              xr.choose?.();
              /* Choosing can end the session — the way out lives in this
                 very list — and the rest of this frame would then be drawing
                 into a room that no longer exists. */
              if (!xr?.session) return;
            }
          }
          if (!dwellOn) menu.dwell = 0;

          /* Scrolling is its own short hold, repeating while the look is
             held there, so a long list is walked rather than jumped. */
          if (menu.open && menu.scrolling !== 0) {
            menu.scrollHeld += dt;
            if (menu.scrollHeld >= MENU_SCROLL_SECONDS) {
              menu.scrollHeld = 0;
              menu.offset = Math.max(0, menu.offset + menu.scrolling);
              rebuildRoomMenu();
            }
          } else {
            menu.scrollHeld = 0;
          }
          xr.lastForward = [forward[0], forward[1], forward[2]];


          for (const eyeView of pose.views) {
            const viewport = layer.getViewport(eyeView);
            gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
            const m = eyeView.transform.inverse.matrix;
            /* World → eye read the other way is eye → world, which for a
               rotation is the transpose. */
            const rotation = new Float32Array([
              m[0], m[4], m[8],
              m[1], m[5], m[9],
              m[2], m[6], m[10],
            ]);
            /* Where this eye is, relative to the head. Half an
               interpupillary distance left or right — the whole reason the
               two eyes see the sphere differently and the brain believes a
               wall is two metres away rather than at infinity. */
            const eyePosition = eyeView.transform.position || { x: 0, y: 0, z: 0 };
            const offset = xr.sphereRadius > 0
              ? [eyePosition.x - headPosition.x, eyePosition.y - headPosition.y, eyePosition.z - headPosition.z]
              : [0, 0, 0];
            gl.useProgram(program2);
            gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
            gl.enableVertexAttribArray(xrPosition);
            gl.vertexAttribPointer(xrPosition, 2, gl.FLOAT, false, 0, 0);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.uniformMatrix4fv(xrUniforms.invProjection, false, invert4(eyeView.projectionMatrix));
            gl.uniformMatrix3fv(xrUniforms.viewRotation, false, rotation);
            gl.uniform3f(xrUniforms.eyeOffset, offset[0], offset[1], offset[2]);
            gl.uniform1f(xrUniforms.sphereRadius, xr.sphereRadius);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            /* Pins and menu ride at the sphere's own distance, so they sit on
               the wall they mark instead of floating in front of it. With the
               sphere at infinity they keep the old fixed six metres. */
            const surfaceDistance = xr.sphereRadius > 0 ? xr.sphereRadius : 6.0;

            if (xr.markers.length && !menu.open && !panel.markerId) {
              gl.useProgram(markerProgram);
              gl.bindBuffer(gl.ARRAY_BUFFER, markerQuad);
              gl.enableVertexAttribArray(markerCorner);
              gl.vertexAttribPointer(markerCorner, 2, gl.FLOAT, false, 0, 0);
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
              gl.uniformMatrix4fv(markerUniforms.projection, false, eyeView.projectionMatrix);
              gl.uniformMatrix3fv(markerUniforms.viewRotationInverse, false, rotation);
              gl.uniform1f(markerUniforms.markerDistance, surfaceDistance);
              gl.uniform3f(markerUniforms.eyeOffset, offset[0], offset[1], offset[2]);
              gl.uniform1f(markerUniforms.reticle, 0);
              for (const marker of xr.markers) {
                const isLooked = marker === looked;
                gl.uniform3f(markerUniforms.markerDirection, marker.dir[0], marker.dir[1], marker.dir[2]);
                /* A pin drawn at half the distance must be half the size, or
                   a smaller room silently grows its pins. */
                const pinScale = surfaceDistance / 6.0;
                /* Aimed at, it is bigger; held, it keeps growing while the
                   dwell fills. A control that shows nothing between "not yet"
                   and "done" is a control nobody can learn — which is how a
                   pin that could only be opened by an absent pinch felt from
                   inside the headset: dead. */
                const holding = menu.dwellOn === `pin:${marker.id}` ? menu.dwell : 0;
                const idle = 0.32 + 0.10 * xr.pinApproach;
                gl.uniform1f(markerUniforms.markerSize,
                  (isLooked ? 0.46 + 0.20 * holding : idle) * pinScale);
                gl.uniform1f(markerUniforms.looking, isLooked ? 1 : 0);
                /* Confirmed by a person and seen only by the AI are different
                   things, and a pin is exactly where that distinction gets lost
                   if it is not carried. */
                const colour = marker.confirmed
                  ? [0.50, 0.84, 0.66, 0.95]
                  : [1.0, 0.81, 0.60, 0.95];
                gl.uniform4f(markerUniforms.markerColour, colour[0], colour[1], colour[2], colour[3]);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
              }
              gl.disable(gl.BLEND);
            }

            {
              gl.useProgram(labelProgram);
              gl.bindBuffer(gl.ARRAY_BUFFER, markerQuad);
              gl.enableVertexAttribArray(labelCorner);
              gl.vertexAttribPointer(labelCorner, 2, gl.FLOAT, false, 0, 0);
              gl.enable(gl.BLEND);
              gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
              gl.uniformMatrix4fv(labelUniforms.projection, false, eyeView.projectionMatrix);
              gl.uniformMatrix3fv(labelUniforms.viewRotationInverse, false, rotation);
              /* The menu is read, not inspected: kept at arm's length even
                 when the walls are closer, so the words stay legible. */
              const menuDistance = Math.min(surfaceDistance, 3.0);
              gl.uniform1f(labelUniforms.labelDistance, menuDistance);
              gl.uniform3f(labelUniforms.eyeOffset, offset[0], offset[1], offset[2]);
              gl.uniform1i(labelUniforms.label, 0);
              /* The capture itself, on its own unit, so a panel can show
                 what is behind it rather than covering it. */
              gl.activeTexture(gl.TEXTURE1);
              gl.bindTexture(gl.TEXTURE_2D, texture);
              gl.uniform1i(labelUniforms.room, 1);
              gl.uniform1f(labelUniforms.glass, 1);
              gl.activeTexture(gl.TEXTURE0);
              const labelScale = menuDistance / 6.0;
              /* `lit` is a level, not a flag: a control part-way to being
                 aimed at should look part-way there. */
              const drawLabel = (labelTexture, dir, width, height, lit, filling, atDistance) => {
                /* A thing standing in the room is a different distance away
                   from wherever the person is now standing, so its size on
                   screen is that distance's business rather than one number
                   shared by everything. */
                const distance = atDistance || menuDistance;
                const scale = distance / 6.0;
                gl.uniform1f(labelUniforms.labelDistance, distance);
                gl.bindTexture(gl.TEXTURE_2D, labelTexture);
                gl.uniform3f(labelUniforms.labelDirection, dir[0], dir[1], dir[2]);
                gl.uniform2f(labelUniforms.labelSize, width * scale, height * scale);
                gl.uniform1f(labelUniforms.looking, typeof lit === "number" ? lit : (lit ? 1 : 0));
                gl.uniform1f(labelUniforms.dwell, filling ? menu.dwell : 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
              };
              if (!menu.open && !panel.markerId && menu.chipTexture) {
                /* Small, and growing as the aim closes on it — the dot is the
                   whole of the closed menu, and its answer to an approaching
                   reticle is the only instruction anybody gets. */
                const dotSize = 0.13 + 0.07 * menu.approach;
                drawLabel(menu.chipTexture, menu.chipDir, dotSize, dotSize,
                  menu.lookingChip ? 1 : menu.approach * 0.8, menu.dwellOn === "__chip",
                  menu.chipDistance);
              }
              if (menu.open && !panel.markerId) {
                for (const item of menu.items) {
                  const lit = item === menu.lookingItem;
                  drawLabel(item.texture, item.dir, lit ? 1.3 : 1.15, lit ? 0.26 : 0.23, lit,
                    menu.dwellOn === item.id, item.distance);
                }
                /* The ends of the column, when the column has more to give.
                   They light while the look is on them, which is also while
                   the list is moving. */
                const edge = (edgeTexture, row, sign) => {
                  if (!edgeTexture || !row) return;
                  const pitch = Math.asin(Math.max(-1, Math.min(1, -row.dir[1]))) + sign * MENU_ROW_PITCH;
                  const flat = Math.hypot(row.dir[0], row.dir[2]) || 1;
                  const scaled = Math.cos(pitch) / flat;
                  drawLabel(edgeTexture, [row.dir[0] * scaled, -Math.sin(pitch), row.dir[2] * scaled],
                    0.78, 0.16, menu.scrolling === sign ? 1 : 0.5, false, row.distance);
                };
                edge(menu.upTexture, menu.items[0], -1);
                edge(menu.downTexture, menu.items[menu.items.length - 1], 1);
              }
              /* The pin's answer, in the room. Held at reading distance and
                 parked where the person was looking when they chose it, with
                 its own way out underneath — because a panel somebody cannot
                 dismiss is worse than one that never opened. */
              if (panel.markerId && panel.texture) {
                drawLabel(panel.texture, panel.dir, 1.62, 0.91, false, false, panel.distance);
                drawLabel(panel.closeTexture, panel.closeDir, 0.15, 0.15,
                  panel.lookingClose ? 1 : 0.55, menu.dwellOn === "__panel-close", panel.closeDistance);
              }

              gl.disable(gl.BLEND);
              /* The sphere's texture unit is shared; leave it bound the way
                 the next frame's video upload expects to find it. */
              gl.bindTexture(gl.TEXTURE_2D, texture);
            }

            /* The reticle, drawn last so nothing can cover it, and drawn
               twice so it reads against a bright wall as well as a dark one.

               It marks where the HEAD points, which is the aim this page can
               actually measure — eyes moving behind a still head steer
               nothing. The first version of it was under two degrees across:
               technically present, practically invisible, and a person with
               no visible aim has no way to learn that aiming is the gesture.
               Reported from the headset as a dot that would not press. */
            gl.useProgram(markerProgram);
            gl.bindBuffer(gl.ARRAY_BUFFER, markerQuad);
            gl.enableVertexAttribArray(markerCorner);
            gl.vertexAttribPointer(markerCorner, 2, gl.FLOAT, false, 0, 0);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            gl.uniformMatrix4fv(markerUniforms.projection, false, eyeView.projectionMatrix);
            gl.uniformMatrix3fv(markerUniforms.viewRotationInverse, false, rotation);
            gl.uniform1f(markerUniforms.markerDistance, 1.6);
            gl.uniform3f(markerUniforms.eyeOffset, offset[0], offset[1], offset[2]);
            gl.uniform3f(markerUniforms.markerDirection, forward[0], forward[1], forward[2]);
            gl.uniform1f(markerUniforms.looking, 0);
            gl.uniform1f(markerUniforms.reticle, 1);
            const aiming = Boolean(menu.lookingChip || menu.lookingItem || looked || panel.lookingClose);
            /* A dark halo first, then the bright ring inside it. */
            gl.uniform1f(markerUniforms.markerSize, 0.075);
            gl.uniform4f(markerUniforms.markerColour, 0.02, 0.06, 0.10, 0.75);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.uniform1f(markerUniforms.markerSize, 0.058);
            gl.uniform4f(markerUniforms.markerColour,
              aiming ? 0.55 : 1, aiming ? 0.91 : 1, aiming ? 0.95 : 1, 0.95);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            gl.disable(gl.BLEND);
          }
        });

        xrSession.addEventListener("end", () => {
          for (const item of xr?.menu.items || []) gl.deleteTexture(item.texture);
          if (xr?.menu.chipTexture) gl.deleteTexture(xr.menu.chipTexture);
          if (xr?.menu.upTexture) gl.deleteTexture(xr.menu.upTexture);
          if (xr?.menu.downTexture) gl.deleteTexture(xr.menu.downTexture);
          if (xr?.panel.texture) gl.deleteTexture(xr.panel.texture);
          if (xr?.panel.closeTexture) gl.deleteTexture(xr.panel.closeTexture);
          xr = null;
          /* Taking the headset off must give the flat viewer back, not a black
             rectangle where a room used to be. */
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.useProgram(program);
          onVRChange?.(false);
          if (state.alive && !state.frame) draw();
        });
        window.cancelAnimationFrame(state.frame);
        state.frame = 0;
        onVRChange?.(true);
        return { ok: true };
      } catch (error) {
        try { await xrSession.end(); } catch (_) { /* already gone */ }
        xr = null;
        return {
          ok: false,
          why: `The immersive view could not be set up — ${error.name || "error"}: ${error.message || error}`,
        };
      }
    }

    /* Read from the same list the flat viewer draws, so a pin added on a laptop
       is in the room the next time somebody stands in it. */
    function setHeadsetMarkers(list) {
      headsetMarkerSource = Array.isArray(list) ? list : [];
      headsetMarkers = headsetMarkerSource
        .filter((marker) => Number.isFinite(Number(marker?.u)) && Number.isFinite(Number(marker?.v)))
        .map((marker) => ({
          id: marker.id,
          label: marker.label || "",
          confirmed: marker.confirmed === true,
          standing: marker.standing || "",
          detail: marker.detail || "",
          source: marker.source || "",
          dir: markerDirection(Number(marker.u), Number(marker.v)),
        }));
      if (xr) {
        xr.markers = headsetMarkers;
        /* The pin somebody was looking at may have just been removed; keeping
           the old object would light a ring that is no longer in the list. */
        xr.looking = headsetMarkers.find((marker) => marker.id === xr.looking?.id) || null;
        /* And an answer about a pin that is no longer in this room — after a
           room change, or a marker deleted on the laptop — closes with it. */
        if (xr.panel.markerId && !headsetMarkers.some((marker) => marker.id === xr.panel.markerId)) {
          xr.closePanel?.();
        }
      }
      return headsetMarkers.length;
    }

    /* The felt size of the room, as the distance of its walls. Zero radius
       is the capture at infinity, exactly as shot; anything else must stay
       between the slider's own bounds — a slider that says 30% and silently
       delivers 34% is a slider that lies. */
    function setRoomSize(size) {
      const bounded = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number(size) || 100));
      headsetRadius = sizeToRadius(bounded);
      if (xr) xr.sphereRadius = headsetRadius;
      return headsetRadius;
    }

    function roomRadius() { return headsetRadius; }

    function exitVR() {
      if (xr?.session) xr.session.end().catch(() => undefined);
    }

    const pointers = new Map();
    let pinchDistance = 0;
    let last = null;

    canvas.addEventListener("pointerdown", (event) => {
      canvas.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      last = { x: event.clientX, y: event.clientY };
      state.dragging = true;
      canvas.classList.add("dragging");
      hide(hintNode);
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size >= 2) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDistance) {
          view.fov = Math.min(2.2, Math.max(0.35, view.fov * (pinchDistance / Math.max(1, distance))));
        }
        pinchDistance = distance;
        return;
      }
      if (!state.dragging || !last) return;
      const scale = view.fov / Math.max(240, stage.clientHeight);
      view.yaw -= (event.clientX - last.x) * scale;
      view.pitch = Math.max(-1.5, Math.min(1.5, view.pitch - (event.clientY - last.y) * scale));
      last = { x: event.clientX, y: event.clientY };
      state.gyro = false;
      if (gyroButton) gyroButton.setAttribute("aria-pressed", "false");
    });
    ["pointerup", "pointercancel", "pointerleave"].forEach((name) =>
      canvas.addEventListener(name, (event) => {
        pointers.delete(event.pointerId);
        if (pointers.size < 2) pinchDistance = 0;
        if (!pointers.size) {
          state.dragging = false;
          last = null;
          canvas.classList.remove("dragging");
        }
      }),
    );
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      view.fov = Math.min(2.2, Math.max(0.35, view.fov + event.deltaY * 0.0016));
    }, { passive: false });

    function onOrientation(event) {
      if (!state.gyro || event.alpha == null) return;
      const rad = Math.PI / 180;
      view.yaw = -event.alpha * rad;
      view.pitch = Math.max(-1.5, Math.min(1.5, (event.beta - 90) * rad));
    }

    if (gyroButton && window.DeviceOrientationEvent) {
      gyroButton.hidden = false;
      gyroButton.onclick = async () => {
        if (state.gyro) {
          state.gyro = false;
          gyroButton.setAttribute("aria-pressed", "false");
          return;
        }
        try {
          const request = window.DeviceOrientationEvent.requestPermission;
          if (typeof request === "function" && (await request()) !== "granted") return;
        } catch {
          return;
        }
        state.gyro = true;
        gyroButton.setAttribute("aria-pressed", "true");
      };
      window.addEventListener("deviceorientation", onOrientation);
    }

    draw();

    const dispose = () => {
      state.alive = false;
      window.cancelAnimationFrame(state.frame);
      window.removeEventListener("deviceorientation", onOrientation);
      if (gyroButton) {
        gyroButton.hidden = true;
        gyroButton.onclick = null;
        gyroButton.setAttribute("aria-pressed", "false");
      }
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };

    /* Looking at a marker is one press, not a hunt: the view turns to it along
       the shortest way round, because a reviewer in a headset should never have
       to spin twice to reach a point that was one step to the left. */
    function lookAt(target, instant) {
      const from = { yaw: view.yaw, pitch: view.pitch };
      let delta = target.yaw - from.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));
      const to = { yaw: from.yaw + delta, pitch: Math.max(-1.5, Math.min(1.5, target.pitch)) };
      state.gyro = false;
      if (gyroButton) gyroButton.setAttribute("aria-pressed", "false");
      if (instant) {
        view.yaw = to.yaw;
        view.pitch = to.pitch;
        return;
      }
      const started = performance.now();
      const step = (now) => {
        if (!state.alive) return;
        const progress = Math.min(1, (now - started) / 420);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
        view.yaw = from.yaw + (to.yaw - from.yaw) * eased;
        view.pitch = from.pitch + (to.pitch - from.pitch) * eased;
        if (progress < 1) window.requestAnimationFrame(step);
      };
      window.requestAnimationFrame(step);
    }

    return {
      dispose, lookAt, view, canvas, enterVR, exitVR, setMedia,
      setHeadsetMarkers, setHeadsetRooms, setRoomSize, roomRadius,
      whenMarkerChosen, whenRoomChosen,
      /* One card, two surfaces: dismissing the evidence on the flat pane
         dismisses it in the room as well. */
      closeHeadsetPanel: () => Boolean(xr?.closePanel?.()),
      xrViews: () => xr?.views || 0,
      xrMarkerCount: () => headsetMarkers.length,
    };
  }

  /* Somewhere to say what happened that is still on the screen when it happens.
     The first draft wrote failures into the drag hint — a node that is removed
     the moment somebody drags the sphere, which every person does before
     reaching for anything in the bar. Pressing the button then looked exactly
     like pressing a dead button, which is the complaint this was meant to
     prevent. */
  function announce(text, tone) {
    let node = root.querySelector("[data-pano-say]");
    if (!node) {
      node = document.createElement("p");
      node.className = "pano-say";
      node.setAttribute("data-pano-say", "");
      node.setAttribute("role", "status");
      stage.appendChild(node);
    }
    node.hidden = !text;
    node.className = `pano-say${tone ? ` ${tone}` : ""}`;
    node.textContent = text || "";
  }

  function hide(node) {
    if (!node) return;
    node.style.opacity = "0";
    window.setTimeout(() => node.remove(), 400);
  }

  /* The window is a window, not a cut: playback, the scrubber and the loop all
     stay inside it, and one button plays the untouched original when a reviewer
     needs to see everything that was filmed. */
  function trimBounds(video, trim, active) {
    const duration = Number(video.duration) || 0;
    if (!active || !trim || !trim.applied) return { start: 0, end: duration };
    const start = Math.max(0, Math.min(Number(trim.start_seconds) || 0, Math.max(0, duration - 1)));
    const end = duration ? Math.min(Number(trim.end_seconds) || duration, duration) : Number(trim.end_seconds) || 0;
    return end > start + 0.5 ? { start, end } : { start: 0, end: duration };
  }

  function buildPlayback(video, trim) {
    const trimmable = Boolean(trim && trim.applied);
    let windowed = trimmable;
    playback = document.createElement("div");
    playback.className = "pano-playback";
    playback.innerHTML = `<button type="button" data-pano-play aria-label="Play or pause">▶</button><input type="range" min="0" max="1000" value="0" step="1" aria-label="Playback position">` +
      (trimmable ? `<button type="button" class="pano-window" data-pano-window aria-pressed="true">Full clip</button>` : "");
    stage.appendChild(playback);
    const button = playback.querySelector("[data-pano-play]");
    const range = playback.querySelector("input");
    const windowButton = playback.querySelector("[data-pano-window]");
    const bounds = () => trimBounds(video, trim, windowed);

    button.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    video.addEventListener("play", () => { button.textContent = "❚❚"; });
    video.addEventListener("pause", () => { button.textContent = "▶"; });
    video.addEventListener("timeupdate", () => {
      const { start, end } = bounds();
      if (windowed && end > start && (video.currentTime >= end - 0.05 || video.currentTime < start - 0.5)) {
        video.currentTime = start;
        return;
      }
      if (range.dataset.seeking === "1" || end <= start) return;
      range.value = String(Math.round(((video.currentTime - start) / (end - start)) * 1000));
    });
    range.addEventListener("pointerdown", () => { range.dataset.seeking = "1"; });
    range.addEventListener("change", () => {
      range.dataset.seeking = "0";
      const { start, end } = bounds();
      if (end > start) video.currentTime = start + (Number(range.value) / 1000) * (end - start);
    });

    if (windowButton) {
      windowButton.addEventListener("click", () => {
        windowed = !windowed;
        windowButton.setAttribute("aria-pressed", windowed ? "true" : "false");
        windowButton.textContent = windowed ? "Full clip" : "Trimmed";
        if (trimNote) trimNote.hidden = !windowed;
        const { start, end } = bounds();
        if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
      });
    }
  }

  function trimText(trim) {
    if (!trim || !trim.applied) return "";
    const head = Number(trim.head_seconds) || 0;
    const tail = Number(trim.tail_seconds) || 0;
    return head === tail
      ? `First and last ${head}s hidden — camera handling`
      : `First ${head}s and last ${tail}s hidden — camera handling`;
  }

  function showTrimNote(trim) {
    const text = trimText(trim);
    if (!text) return;
    trimNote = document.createElement("p");
    trimNote.className = "pano-trim-note";
    trimNote.textContent = text;
    stage.appendChild(trimNote);
  }

  /* A capture uploaded before the policy existed carries no window, so the
     policy is applied to the stream that is playing. Non-spatial evidence is
     never passed a window at all and is therefore never trimmed. */
  function resolveTrim(trim, video) {
    if (!trim) return null;
    if (!window.MDAITrim360) return trim.applied ? trim : null;
    const resolved = window.MDAITrim360.resolve({ trim }, Number(video && video.duration) || 0);
    return resolved.applied ? resolved : null;
  }

  function seekToWindowStart(video, trim) {
    if (!trim) return;
    const seek = () => {
      const resolved = resolveTrim(trim, video);
      if (!resolved) return;
      const { start } = trimBounds(video, resolved, true);
      if (start > 0 && Math.abs(video.currentTime - start) > 0.2) video.currentTime = start;
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
  }

  /* ------------------------------------------------------------- Markers */

  /* A marker answers, in place, the questions a paragraph cannot: what is this,
     who says so, which file and second shows it, what has it cost, and which
     document covers it. Where the record has no answer the card says so and
     offers the only useful next move — asking for the missing document. */

  const markerState = {
    list: [],
    sphere: null,
    media: null,
    canReview: false,
    canPlace: false,
    onReview: null,
    onPlace: null,
    onRequest: null,
    layer: null,
    pins: new Map(),
    openId: null,
    aiming: false,
  };

  function markerTone(marker) {
    return window.MDAIMarkers360?.stateTone(marker.state) || "review";
  }

  function markerStateLabel(marker) {
    return window.MDAIMarkers360?.stateLabel(marker.state) || "Seen by AI · not verified";
  }

  function clearMarkerPanels() {
    markerState.sphere?.closeHeadsetPanel?.();
    stage.querySelectorAll(".pano-card, .pano-list").forEach((node) => node.remove());
    markerState.openId = null;
    markerState.pins.forEach((pin) => pin.setAttribute("aria-expanded", "false"));
  }

  function markerMoment(marker) {
    const media = markerState.media;
    if (!media || typeof media.currentTime !== "number") return false;
    const at = Number(marker.timestamp_seconds);
    if (!Number.isFinite(at) || at < 0) return false;
    media.currentTime = at;
    if (media.paused) media.play().catch(() => {});
    return true;
  }

  /* Turning to a marker aims slightly above it: the card that is about to open
     covers the lower part of the screen, and a card that hides the very thing
     it describes is worse than no card. */
  const CARD_CLEARANCE = 0.24;

  function lookAtMarker(marker, instant) {
    if (!markerState.sphere?.lookAt || !window.MDAIMarkers360) return;
    const target = window.MDAIMarkers360.view(marker);
    markerState.sphere.lookAt({ yaw: target.yaw, pitch: target.pitch - CARD_CLEARANCE }, instant);
  }

  function markerRow(term, value, missing) {
    return `<dt>${escapeText(term)}</dt><dd class="${missing ? "missing" : ""}">${escapeText(value)}</dd>`;
  }

  function openMarkerCard(marker) {
    clearMarkerPanels();
    markerState.openId = marker.id;
    markerState.pins.get(marker.id)?.setAttribute("aria-expanded", "true");
    const hasMoment = marker.timestamp_seconds != null && Number.isFinite(Number(marker.timestamp_seconds));
    const timecode = hasMoment ? window.MDAIMarkers360?.timecode(marker.timestamp_seconds) || "" : "";
    const seenIn = [marker.source_name || "this capture", timecode ? `at ${timecode}` : ""]
      .filter(Boolean)
      .join(" ");
    const card = document.createElement("div");
    card.className = "pano-card";
    card.innerHTML = `
      <button class="pano-card-close" type="button" data-marker-close aria-label="Close">✕</button>
      <span class="pano-chip ${markerTone(marker)}">${escapeText(markerStateLabel(marker))}</span>
      <h3>${escapeText(marker.label || "Marked point")}</h3>
      ${marker.detail && marker.detail !== marker.label ? `<p>${escapeText(marker.detail)}</p>` : ""}
      <dl>
        ${markerRow("Seen in", seenIn)}
        ${markerRow(
          "Since the previous capture",
          marker.change || "Not established — no earlier capture of this space is on record",
          !marker.change,
        )}
        ${markerRow("Cost", marker.cost || "Not linked to a cost", !marker.cost)}
        ${markerRow(
          "Document",
          marker.document || (marker.requested ? "Requested — waiting for the contractor" : "No document covers this installation"),
          !marker.document,
        )}
      </dl>
      <div class="pano-card-actions">
        ${hasMoment ? `<button type="button" class="primary" data-marker-moment>Show this moment</button>` : ""}
        ${markerState.canReview && marker.state !== "confirmed" ? `<button type="button" data-marker-review="confirmed">Confirm</button>` : ""}
        ${markerState.canReview && marker.state !== "rejected" ? `<button type="button" data-marker-review="rejected">Incorrect</button>` : ""}
        ${markerState.canReview && marker.state !== "needs_more" ? `<button type="button" data-marker-review="needs_more">Needs more evidence</button>` : ""}
        ${!marker.document && !marker.requested && markerState.onRequest ? `<button type="button" class="quiet" data-marker-request>Ask for the document</button>` : ""}
      </div>`;
    stage.appendChild(card);
    card.querySelector("[data-marker-close]").addEventListener("click", clearMarkerPanels);
    card.querySelector("[data-marker-moment]")?.addEventListener("click", () => {
      if (!markerMoment(marker)) return;
      lookAtMarker(marker);
    });
    card.querySelectorAll("[data-marker-review]").forEach((button) => {
      button.addEventListener("click", () => {
        marker.state = button.dataset.markerReview;
        markerState.onReview?.(marker, marker.state);
        renderMarkerPins();
        syncHeadsetMarkers();
        openMarkerCard(marker);
      });
    });
    card.querySelector("[data-marker-request]")?.addEventListener("click", () => {
      marker.requested = true;
      markerState.onRequest?.(marker);
      openMarkerCard(marker);
    });
  }

  function openMarkerList() {
    clearMarkerPanels();
    const panel = document.createElement("div");
    panel.className = "pano-list";
    const rows = markerState.list
      .map(
        (marker, index) =>
          `<button class="row" type="button" data-marker-jump="${escapeText(marker.id)}">
             <span>${index + 1}. ${escapeText(marker.label || "Marked point")}</span>
             <em class="pano-chip ${markerTone(marker)}">${escapeText(markerStateLabel(marker))}</em>
           </button>`,
      )
      .join("");
    panel.innerHTML = `
      <button class="pano-card-close" type="button" data-marker-close aria-label="Close">✕</button>
      <h3>${markerState.list.length} point${markerState.list.length === 1 ? "" : "s"} marked in this space</h3>
      ${rows || `<p style="color:#8fa2b5;font-size:13px">Nothing is marked yet. Aim at a point and place the first marker.</p>`}
      ${markerState.canPlace ? `<button class="row" type="button" data-marker-add><span>＋ Place a marker where I am looking</span></button>` : ""}`;
    stage.appendChild(panel);
    panel.querySelector("[data-marker-close]").addEventListener("click", clearMarkerPanels);
    panel.querySelectorAll("[data-marker-jump]").forEach((button) => {
      button.addEventListener("click", () => {
        const marker = markerState.list.find((item) => item.id === button.dataset.markerJump);
        if (!marker) return;
        lookAtMarker(marker);
        openMarkerCard(marker);
      });
    });
    panel.querySelector("[data-marker-add]")?.addEventListener("click", startMarkerPlacement);
  }

  /* Placing by aim rather than by tap: a tap on the sphere is already a drag,
     and in a headset there is no tap at all. Look at the thing, then press. */
  function startMarkerPlacement() {
    clearMarkerPanels();
    markerState.aiming = true;
    const reticle = document.createElement("div");
    reticle.className = "pano-reticle";
    stage.appendChild(reticle);
    const card = document.createElement("div");
    card.className = "pano-card";
    card.innerHTML = `
      <h3>Place a marker</h3>
      <p>Turn the view until the ring sits on the thing you want to mark, then name it.</p>
      <input type="text" data-marker-name placeholder="What is at this point?"
        style="width:100%;min-height:46px;margin-bottom:12px;padding:0 12px;border:1px solid #35506a;border-radius:10px;background:rgba(4,9,15,.6);color:#edf4f7;font:inherit;font-size:14px">
      <div class="pano-card-actions">
        <button type="button" class="primary" data-marker-save>Place it here</button>
        <button type="button" class="quiet" data-marker-cancel>Cancel</button>
      </div>`;
    stage.appendChild(card);
    const input = card.querySelector("[data-marker-name]");
    input.focus();
    const stop = () => {
      markerState.aiming = false;
      reticle.remove();
      card.remove();
    };
    card.querySelector("[data-marker-cancel]").addEventListener("click", stop);
    card.querySelector("[data-marker-save]").addEventListener("click", () => {
      const label = input.value.trim();
      if (!label) {
        input.focus();
        return;
      }
      const anchor = window.MDAIMarkers360.anchorFromView(markerState.sphere.view);
      const marker = window.MDAIMarkers360.place(anchor, {
        label,
        evidence_id: markerState.evidenceId || null,
        timestamp_seconds: markerState.media && typeof markerState.media.currentTime === "number"
          ? Number(markerState.media.currentTime.toFixed(2))
          : null,
      });
      markerState.list.push(marker);
      markerState.onPlace?.(marker);
      syncHeadsetMarkers();
      stop();
      renderMarkerPins();
      updateMarkerButton();
      renderMarkerAction();
      openMarkerCard(marker);
    });
  }

  function renderMarkerPins() {
    if (!markerState.layer) return;
    markerState.layer.innerHTML = "";
    markerState.pins.clear();
    markerState.list.forEach((marker, index) => {
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = `pano-pin state-${markerTone(marker)}`;
      pin.setAttribute("aria-expanded", markerState.openId === marker.id ? "true" : "false");
      pin.innerHTML = `<i></i><b>${index + 1}. ${escapeText(marker.label || "Marked point")}</b>`;
      // Keyboard reaches the pin directly; a finger reaches it through the
      // canvas, so that dragging the sphere always wins over hitting a dot.
      pin.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        lookAtMarker(marker);
        openMarkerCard(marker);
      });
      markerState.layer.appendChild(pin);
      markerState.pins.set(marker.id, pin);
    });
  }

  function layoutMarkerPins(viewState) {
    if (!markerState.layer || !window.MDAIMarkers360) return;
    const width = markerState.layer.clientWidth;
    const height = markerState.layer.clientHeight;
    markerState.list.forEach((marker) => {
      const pin = markerState.pins.get(marker.id);
      if (!pin) return;
      const point = window.MDAIMarkers360.project(marker, viewState);
      if (!point.visible) {
        pin.style.display = "none";
        return;
      }
      pin.style.display = "";
      // A pin far from where the reviewer is looking keeps its dot and drops
      // its label, so twenty markers never turn the sphere into a wall of text.
      pin.classList.toggle("far", Math.hypot(point.x, point.y) > 0.45);
      const left = ((point.x + 1) / 2) * width;
      const top = ((1 - point.y) / 2) * height;
      pin.style.transform = `translate(${left}px, ${top}px)`;
      pin.dataset.screenX = String(left);
      pin.dataset.screenY = String(top);
    });
  }

  function updateMarkerButton() {
    if (!markerButton) return;
    const count = markerState.list.length;
    const usable = Boolean(markerState.sphere) && (count > 0 || markerState.canPlace);
    markerButton.hidden = !usable;
    markerButton.textContent = count ? `◎ ${count} marked` : "◎ Markers";
    markerButton.setAttribute(
      "aria-label",
      count ? `${count} marked points in this space` : "Place a marker",
    );
  }

  /* A tap is a press that did not turn the view. Only then is the nearest pin
     within thumb reach opened — so a marker never blocks looking around. */
  function bindMarkerTaps(canvas) {
    let press = null;
    canvas.addEventListener("pointerdown", (event) => {
      press = { x: event.clientX, y: event.clientY, at: performance.now() };
    });
    canvas.addEventListener("pointerup", (event) => {
      const start = press;
      press = null;
      if (!start || markerState.aiming) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) return;
      if (performance.now() - start.at > 700) return;
      const box = canvas.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      let closest = null;
      let distance = 34;
      markerState.list.forEach((marker) => {
        const pin = markerState.pins.get(marker.id);
        if (!pin || pin.style.display === "none") return;
        // The label is as much a target as the dot: a person aims at the words.
        const label = pin.querySelector("b").getBoundingClientRect();
        const onLabel =
          label.width > 0 &&
          event.clientX >= label.left && event.clientX <= label.right &&
          event.clientY >= label.top && event.clientY <= label.bottom;
        const gap = onLabel
          ? 0
          : Math.hypot(Number(pin.dataset.screenX) - x, Number(pin.dataset.screenY) - y);
        if (gap < distance) {
          distance = gap;
          closest = marker;
        }
      });
      if (closest) openMarkerCard(closest);
    });
  }

  /* One list, two places it is drawn: the pins on the flat pane and the rings
     standing in the room. They are fed from the same array on purpose — a
     marker confirmed on a laptop is green in the headset the moment somebody
     puts it on, and a marker that only the AI has seen is never shown as
     confirmed in either. */
  function syncHeadsetMarkers() {
    if (!markerState.sphere?.setHeadsetMarkers) return 0;
    return markerState.sphere.setHeadsetMarkers(
      markerState.list.map((marker) => ({
        id: marker.id,
        label: marker.label || "",
        u: marker.u,
        v: marker.v,
        confirmed: marker.state === "confirmed",
        /* What the pin has to be able to SAY inside the headset. Carried at
           this seam because the immersive session cannot read the DOM card:
           a pin that opens a panel a headset cannot show is a pin that does
           nothing, which is exactly how this was reported. */
        standing: markerStateLabel(marker),
        detail: marker.detail && marker.detail !== marker.label ? marker.detail : "",
        source: marker.source_name || "",
      })),
    );
  }

  function mountMarkers(sphere, media, options) {
    markerState.sphere = sphere;
    markerState.media = media;
    markerState.list = Array.isArray(options.markers) ? options.markers.slice() : [];
    markerState.canReview = Boolean(options.canReviewMarkers);
    markerState.canPlace = Boolean(options.onMarkerPlace);
    markerState.onReview = options.onMarkerReview || null;
    markerState.onPlace = options.onMarkerPlace || null;
    markerState.onRequest = options.onMarkerRequest || null;
    markerState.evidenceId = options.evidenceId || null;
    markerState.layer = document.createElement("div");
    markerState.layer.className = "pano-markers";
    stage.appendChild(markerState.layer);
    renderMarkerPins();
    updateMarkerButton();
    renderMarkerAction();
    syncHeadsetMarkers();
    /* Looking at a pin in the room and choosing it opens the same card the
       flat viewer opens. Somebody in a headset gets the evidence, not a dot. */
    sphere?.whenMarkerChosen?.((id) => {
      const marker = markerState.list.find((item) => item.id === id);
      if (marker) openMarkerCard(marker);
    });
    if (sphere?.canvas) bindMarkerTaps(sphere.canvas);
  }

  function resetMarkers() {
    markerState.sphere?.setHeadsetMarkers?.([]);
    markerState.list = [];
    markerState.sphere = null;
    markerState.media = null;
    markerState.layer = null;
    markerState.pins.clear();
    markerState.openId = null;
    markerState.aiming = false;
    if (markerButton) markerButton.hidden = true;
  }

  function renderFooter(actions = []) {
    footer.innerHTML = "";
    actions
      .filter((action) => action && action.label)
      .forEach((action) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = action.label;
        if (action.primary) button.className = "primary";
        button.addEventListener("click", () => action.onSelect?.());
        footer.appendChild(button);
      });
    footer.hidden = !footer.children.length;
  }

  /* The one action this screen exists for cannot live in a glyph in the corner.
     A person who has not been told what "◎" means will never press it, and the
     feature may as well not exist. */
  function renderMarkerAction() {
    footer.querySelector("[data-pano-add-marker]")?.remove();
    if (!markerState.canPlace) {
      footer.hidden = !footer.children.length;
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.panoAddMarker = "1";
    button.className = "primary";
    button.textContent = markerState.list.length
      ? `＋ Add a marker (${markerState.list.length} here)`
      : "＋ Add a marker";
    button.addEventListener("click", startMarkerPlacement);
    footer.insertBefore(button, footer.firstChild);
    footer.hidden = false;
  }

  function teardown() {
    resetMarkers();
    activeSphere = null;
    activeSwapMedia?.pause?.();
    activeSwapMedia = null;
    /* Both belong to a sphere that is about to stop existing. Left on screen
       they are two controls that do nothing, which is the same failure as a
       button that does nothing when pressed. */
    if (vrButton) { vrButton.hidden = true; vrButton.onclick = null; }
    if (scaleControl) scaleControl.hidden = true;
    if (scaleInput) scaleInput.oninput = null;
    if (!session) return;
    session.dispose?.();
    session = null;
    stage.innerHTML = "";
    playback = null;
    trimNote = null;
  }

  function close() {
    teardown();
    root.hidden = true;
    // A surface underneath may still own the scroll lock, so restore what it set.
    document.body.style.overflow = restoreOverflow;
  }

  function open(options = {}) {
    const {
      src,
      mediaType = "",
      title = "Evidence",
      subtitle = "",
      spatial = false,
      trim = null,
      actions = [],
    } = options;
    if (!root) build();
    teardown();
    titleNode.textContent = title;
    subtitleNode.textContent = subtitle;
    renderFooter(actions);
    if (root.hidden) restoreOverflow = document.body.style.overflow;
    root.hidden = false;
    document.body.style.overflow = "hidden";

    const kind = String(mediaType || "").toLowerCase();
    const isVideo = kind.startsWith("video") || /\.(mp4|mov|m4v|webm)$/i.test(String(src || ""));
    const isImage = kind.startsWith("image") || /\.(jpg|jpeg|png|webp|heic)$/i.test(String(src || ""));

    if (!src) {
      stage.innerHTML = `<div class="pano-doc"><strong>${escapeText(title)}</strong><p>${escapeText(subtitle || "This file has no viewable stream.")}</p></div>`;
      return;
    }

    if (!isVideo && !isImage) {
      stage.innerHTML = `<div class="pano-doc"><strong>${escapeText(title)}</strong><p>Documents open in a separate tab so the original file stays untouched.</p><a href="${escapeText(src)}" target="_blank" rel="noopener">Open document ↗</a></div>`;
      return;
    }

    const media = document.createElement(isVideo ? "video" : "img");
    // The sphere shader samples the file as a WebGL texture, which requires a
    // CORS-clean response. Flat playback does not, so the attribute is only set
    // when the file is actually rendered spatially.
    if (spatial) media.crossOrigin = "anonymous";
    if (isVideo) {
      media.playsInline = true;
      media.loop = true;
      media.muted = true;
      media.preload = "auto";
    }
    media.src = src;

    if (!spatial) {
      if (isVideo) {
        media.controls = true;
        media.muted = false;
        media.className = "pano-flat";
        seekToWindowStart(media, trim);
      }
      media.alt = title;
      stage.appendChild(media);
      session = { dispose: () => { if (isVideo) media.pause(); } };
      return;
    }

    hintNode = document.createElement("p");
    hintNode.className = "pano-hint";
    hintNode.textContent = "Drag to look around · press ＋ Add a marker to mark what you see";
    stage.appendChild(hintNode);

    const start = () => {
      try {
        const sphere = startSphere(media, isVideo, layoutMarkerPins, (inHeadset) => {
          if (!vrButton) return;
          vrButton.textContent = inHeadset ? "◉ Leave the room" : "◉ Stand in this room";
        });
        activeSphere = sphere;
        if (Array.isArray(options.rooms) && options.rooms.length && typeof options.onRoomChosen === "function") {
          sphere.setHeadsetRooms(options.rooms);
          sphere.whenRoomChosen(options.onRoomChosen);
        }
        session = {
          dispose: () => {
            sphere.exitVR();
            sphere.dispose();
            if (isVideo) media.pause();
          },
        };
        /* The control appears only after the device has said it can. */
        headsetCanDoThis().then((offered) => {
          if (!vrButton) return;
          vrButton.hidden = !offered;
          if (scaleControl) scaleControl.hidden = !offered;
          if (!offered) return;
          if (scaleInput) {
            const apply = (size) => {
              sphere.setRoomSize(size);
              scaleInput.value = String(size);
              if (scaleValue) scaleValue.textContent = `${size}%`;
            };
            apply(rememberedRoomSize());
            scaleInput.oninput = () => {
              const size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number(scaleInput.value) || 100));
              apply(size);
              rememberRoomSize(size);
            };
          }
          vrButton.onclick = async () => {
            if (sphere.xrViews()) { sphere.exitVR(); return; }
            vrButton.disabled = true;
            announce("Opening the immersive view…");
            const result = await sphere.enterVR();
            vrButton.disabled = false;
            if (result.ok) {
              /* Two views is stereo. One is a flat pane inside a headset, which
                 is a different product. Worth saying once. */
              window.setTimeout(() => {
                const views = sphere.xrViews();
                announce(views ? `Immersive view running · ${views} view${views === 1 ? "" : "s"}${views >= 2 ? " (stereo)" : " (flat)"}` : "", views >= 2 ? "good" : "bad");
              }, 900);
              return;
            }
            /* Never nothing. A press that fails says why, in the words the
               device used. */
            announce(result.why, "bad");
          };
        });
        mountMarkers(sphere, isVideo ? media : null, options);
        // Arriving from a findings row: land looking at the point that row is
        // about, not at whatever direction the capture happened to start in.
        const focused = markerState.list.find((marker) => marker.id === options.focusMarkerId);
        if (focused) {
          lookAtMarker(focused, true);
          openMarkerCard(focused);
        }
        if (isVideo) {
          const window360 = resolveTrim(trim, media);
          showTrimNote(window360);
          buildPlayback(media, window360);
          seekToWindowStart(media, window360);
          media.play().catch(() => {});
        }
      } catch (error) {
        console.error("360 viewer", error);
        stage.innerHTML = "";
        if (isVideo) {
          media.controls = true;
          media.className = "pano-flat";
          seekToWindowStart(media, trim);
        }
        stage.appendChild(media);
        const note = document.createElement("p");
        note.className = "pano-hint";
        note.textContent = "This device cannot render the 360 sphere. The flat original is shown instead.";
        stage.appendChild(note);
        session = { dispose: () => { if (isVideo) media.pause(); } };
      }
    };

    if (isVideo) media.addEventListener("loadeddata", start, { once: true });
    else media.addEventListener("load", start, { once: true });
    media.addEventListener("error", () => {
      if (media.crossOrigin) {
        // The storage bucket did not return CORS headers. The evidence still has
        // to be viewable, so fall back to flat playback of the same original.
        stage.innerHTML = "";
        const flat = document.createElement(isVideo ? "video" : "img");
        flat.src = src;
        flat.alt = title;
        if (isVideo) {
          flat.controls = true;
          flat.playsInline = true;
          flat.className = "pano-flat";
          seekToWindowStart(flat, trim);
        }
        stage.appendChild(flat);
        const note = document.createElement("p");
        note.className = "pano-hint";
        note.textContent = "Spatial playback needs cross-origin access to the storage bucket. The flat original is shown instead.";
        stage.appendChild(note);
        session = { dispose: () => { if (isVideo) flat.pause(); } };
        return;
      }
      stage.innerHTML = `<div class="pano-doc"><strong>The file could not be loaded</strong><p>The secure link may have expired. Reopen the project and try again.</p></div>`;
    }, { once: true });
  }

  /* The viewer stays, the room changes. Called by the opener when a room is
     chosen from inside the headset (or anywhere else): the new capture loads
     off-screen first, and only a ready frame replaces the sphere's texture —
     the person in the headset sees the old room until the new one exists,
     never a black void. The XR session is untouched throughout. */
  function swapRoom(options = {}) {
    if (!activeSphere) return false;
    const { src, mediaType = "", title = "Evidence", subtitle = "", trim = null } = options;
    if (!src) return false;
    const kind = String(mediaType || "").toLowerCase();
    const nextIsVideo = kind.startsWith("video") || /\.(mp4|mov|m4v|webm)$/i.test(String(src || ""));
    const nextMedia = document.createElement(nextIsVideo ? "video" : "img");
    nextMedia.crossOrigin = "anonymous";
    if (nextIsVideo) {
      nextMedia.playsInline = true;
      nextMedia.loop = true;
      nextMedia.muted = true;
      nextMedia.preload = "auto";
    }
    nextMedia.src = src;
    const arrive = () => {
      const sphere = activeSphere;
      if (!sphere) return;
      sphere.setMedia(nextMedia, nextIsVideo);
      activeSwapMedia = nextIsVideo ? nextMedia : null;
      titleNode.textContent = title;
      subtitleNode.textContent = subtitle;
      /* The new room's markers and review powers replace the old room's —
         a pin from the Family Room has no business in the Dining Room. */
      markerState.media = nextIsVideo ? nextMedia : null;
      markerState.list = Array.isArray(options.markers) ? options.markers.slice() : [];
      markerState.canReview = Boolean(options.canReviewMarkers);
      markerState.canPlace = Boolean(options.onMarkerPlace);
      markerState.onReview = options.onMarkerReview || null;
      markerState.onPlace = options.onMarkerPlace || null;
      markerState.onRequest = options.onMarkerRequest || null;
      markerState.evidenceId = options.evidenceId || null;
      markerState.openId = null;
      markerState.aiming = false;
      markerState.pins.clear();
      if (markerState.layer) markerState.layer.innerHTML = "";
      renderMarkerPins();
      updateMarkerButton();
      renderMarkerAction();
      syncHeadsetMarkers();
      if (Array.isArray(options.rooms)) sphere.setHeadsetRooms(options.rooms);
      playback?.remove();
      playback = null;
      trimNote?.remove();
      trimNote = null;
      if (nextIsVideo) {
        const window360 = resolveTrim(trim, nextMedia);
        showTrimNote(window360);
        buildPlayback(nextMedia, window360);
        seekToWindowStart(nextMedia, window360);
        nextMedia.play().catch(() => {});
      }
      announce(`Now in ${title}`, "good");
    };
    if (nextIsVideo) nextMedia.addEventListener("loadeddata", arrive, { once: true });
    else nextMedia.addEventListener("load", arrive, { once: true });
    nextMedia.addEventListener("error", () => {
      announce("That room could not be loaded — you are still in the previous one.", "bad");
    }, { once: true });
    return true;
  }

  window.MDAIPano360 = { open, close, swapRoom };
})();
