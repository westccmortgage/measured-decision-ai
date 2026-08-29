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
    void main() {
      float radius = length(vCorner);
      if (radius > 1.0) discard;
      /* A ring rather than a blob: it has to be visible against timber and
         daylight alike without hiding what it points at. */
      float edge = smoothstep(1.0, 0.86, radius);
      float hole = smoothstep(0.52, 0.66, radius);
      float alpha = edge * mix(hole, 1.0, looking * 0.55);
      gl_FragColor = vec4(markerColour.rgb, markerColour.a * alpha);
    }`;

  /* The room menu: text baked to a canvas, carried into the scene as a quad
     that faces the viewer exactly the way a pin does. WebGL has no words of
     its own, and a person inside a headset must not have to take it off to
     read which room is which. */
  const LABEL_VERTEX_SHADER = `
    attribute vec2 corner;
    varying vec2 vUv;
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
      gl_Position = projection * vec4(mat3(
        viewRotationInverse[0][0], viewRotationInverse[0][1], viewRotationInverse[0][2],
        viewRotationInverse[1][0], viewRotationInverse[1][1], viewRotationInverse[1][2],
        viewRotationInverse[2][0], viewRotationInverse[2][1], viewRotationInverse[2][2]
      ) * world, 1.0);
    }`;

  const LABEL_FRAGMENT_SHADER = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D label;
    uniform float looking;
    void main() {
      vec4 colour = texture2D(label, vUv);
      gl_FragColor = vec4(colour.rgb + vec3(looking * 0.18), colour.a);
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
  const MENU_CHIP_PITCH = 0.38;
  const MENU_ITEM_PITCH = 0.14;
  const MENU_HOLD_ANGLE = 0.87;
  const MENU_CHIP_COS = Math.cos(MENU_CHIP_PITCH);
  const MENU_CHIP_SIN = Math.sin(MENU_CHIP_PITCH);
  const MENU_ITEM_COS = Math.cos(MENU_ITEM_PITCH);
  const MENU_ITEM_SIN = Math.sin(MENU_ITEM_PITCH);

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
      ink.font = "600 40px Inter, system-ui, sans-serif";
      ink.textAlign = "center";
      ink.textBaseline = "middle";
      ink.fillStyle = current ? "#8ce8f3" : "#edf5f7";
      let shown = String(text || "");
      while (shown.length > 4 && ink.measureText(shown).width > 452) shown = `${shown.slice(0, -2).trimEnd()}…`;
      ink.fillText(shown, 256, 50);
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
      menu.items = headsetRooms.map((room) => ({
        id: room.id,
        current: Boolean(room.current),
        texture: bakeLabelTexture(room.current ? `● ${room.title}` : room.title, Boolean(room.current)),
        dir: [0, -1, 0],
      }));
      /* The way out rides in the same list. A person who can walk to any
         room from inside the headset must be able to walk back to the
         screen the same way — asked for in exactly those words. */
      menu.items.push({
        id: "__exit-vr",
        exit: true,
        current: false,
        texture: bakeLabelTexture("◉ Back to the screen", false),
        dir: [0, -1, 0],
      });
      menu.chipTexture = bakeLabelTexture(headsetRooms.length ? "Rooms ▾" : "◉ Menu", false);
    }

    function setHeadsetRooms(list) {
      headsetRooms = (Array.isArray(list) ? list : [])
        .filter((room) => room && room.id && room.title)
        .slice(0, 8);
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
          menu: { open: false, items: [], chipTexture: null, chipDir: [0, -1, 0], heading: null, lookingChip: false, lookingItem: null },
        };
        rebuildRoomMenu();
        /* Test hooks: the lazy remap centre, the pin list, and the room menu —
           each observable and drivable without a headset, so what only runs
           inside one can still be proven on a machine that has none. */
        window.__xrAnchor = () => xr?.anchor || null;
        window.__xrSetMarkers = (list) => setHeadsetMarkers(list || []);
        window.__xrMenu = () => (xr ? {
          open: xr.menu.open,
          chipDir: xr.menu.chipDir.slice(),
          heading: xr.menu.heading ? xr.menu.heading.slice() : null,
          items: xr.menu.items.map((item) => ({ id: item.id, dir: item.dir.slice(), current: item.current, exit: Boolean(item.exit) })),
          lookingChip: xr.menu.lookingChip,
          lookingItem: xr.menu.lookingItem?.id || null,
        } : null);

        /* A pinch, a controller trigger, a tap — whatever the device calls
           choosing something. The menu owns the gesture while it is on
           screen; otherwise the pin somebody is looking at opens, which is
           the whole point of putting pins in the room. */
        xrSession.addEventListener("select", () => {
          const menu = xr?.menu;
          if (menu?.items.length) {
            if (menu.lookingItem) {
              const chosen = menu.lookingItem;
              menu.open = false;
              if (chosen.exit) exitVR();
              else if (!chosen.current) onRoomChosen?.(chosen.id);
              return;
            }
            if (menu.lookingChip) {
              menu.open = !menu.open;
              return;
            }
            if (menu.open) {
              menu.open = false;
              return;
            }
          }
          const marker = xr?.looking;
          if (!marker) return;
          onMarkerChosen?.(marker.id);
        });

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
          /* Where the head is pointing, taken once per frame from the first
             view: the two eyes look the same way. */
          const head = pose.views[0].transform.inverse.matrix;
          const forward = [-head[2], -head[6], -head[10]];
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
          const menu = xr.menu;
          if (menu.items.length) {
            const flat = Math.hypot(forward[0], forward[2]);
            /* Looking straight up or down says nothing about which way the
               person is facing; the last good heading does. */
            if (flat > 0.35) {
              const gazeHeading = [forward[0] / flat, forward[2] / flat];
              const settled = menu.heading || gazeHeading;
              const turnedAway = settled[0] * gazeHeading[0] + settled[1] * gazeHeading[1] < Math.cos(MENU_HOLD_ANGLE);
              /* Reaching for the menu holds it still; turning well away from
                 it brings it back around to where the person now faces. */
              if (!menu.heading || (!menu.open && !menu.lookingChip && turnedAway)) menu.heading = gazeHeading;
            } else if (!menu.heading) {
              menu.heading = [0, -1];
            }
            const heading = menu.heading;
            menu.chipDir = [heading[0] * MENU_CHIP_COS, -MENU_CHIP_SIN, heading[1] * MENU_CHIP_COS];
            const spread = 0.30;
            menu.items.forEach((item, index) => {
              const yaw = (index - (menu.items.length - 1) / 2) * spread;
              const turned = [
                heading[0] * Math.cos(yaw) + heading[1] * Math.sin(yaw),
                heading[1] * Math.cos(yaw) - heading[0] * Math.sin(yaw),
              ];
              item.dir = [turned[0] * MENU_ITEM_COS, -MENU_ITEM_SIN, turned[1] * MENU_ITEM_COS];
            });
            let lookedItem = null;
            let bestItem = Math.cos(0.19);
            if (menu.open) {
              for (const item of menu.items) {
                const dot = item.dir[0] * forward[0] + item.dir[1] * forward[1] + item.dir[2] * forward[2];
                if (dot > bestItem) { bestItem = dot; lookedItem = item; }
              }
            }
            menu.lookingItem = lookedItem;
            const chipDot = menu.chipDir[0] * forward[0] + menu.chipDir[1] * forward[1] + menu.chipDir[2] * forward[2];
            menu.lookingChip = !lookedItem && chipDot > Math.cos(0.22);
          } else {
            menu.lookingChip = false;
            menu.lookingItem = null;
          }

          /* The pin nearest to where somebody is looking, and only if they are
             looking near it at all. Highlighting whatever happens to be closest
             would light one up permanently, wherever the head turned. An open
             menu owns the gaze — a pin must not light up through the list. */
          let looked = null;
          if (!menu.open) {
            let best = Math.cos(0.14);
            for (const marker of xr.markers) {
              const dot = marker.dir[0] * forward[0] + marker.dir[1] * forward[1] + marker.dir[2] * forward[2];
              if (dot > best) { best = dot; looked = marker; }
            }
          }
          xr.looking = looked;

          /* The head's own position, so each eye's offset is measured from
             the centre of the head rather than from the origin of whatever
             reference space the device handed back. */
          const headPosition = pose.transform?.position || { x: 0, y: 0, z: 0 };

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

            if (xr.markers.length && !menu.open) {
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
              for (const marker of xr.markers) {
                const isLooked = marker === looked;
                gl.uniform3f(markerUniforms.markerDirection, marker.dir[0], marker.dir[1], marker.dir[2]);
                /* A pin drawn at half the distance must be half the size, or
                   a smaller room silently grows its pins. */
                const pinScale = surfaceDistance / 6.0;
                gl.uniform1f(markerUniforms.markerSize, (isLooked ? 0.46 : 0.32) * pinScale);
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

            if (menu.items.length) {
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
              gl.activeTexture(gl.TEXTURE0);
              const labelScale = menuDistance / 6.0;
              const drawLabel = (labelTexture, dir, width, height, lit) => {
                gl.bindTexture(gl.TEXTURE_2D, labelTexture);
                gl.uniform3f(labelUniforms.labelDirection, dir[0], dir[1], dir[2]);
                gl.uniform2f(labelUniforms.labelSize, width * labelScale, height * labelScale);
                gl.uniform1f(labelUniforms.looking, lit ? 1 : 0);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
              };
              if (menu.chipTexture) drawLabel(menu.chipTexture, menu.chipDir, 0.9, 0.2, menu.lookingChip);
              if (menu.open) {
                for (const item of menu.items) {
                  const lit = item === menu.lookingItem;
                  drawLabel(item.texture, item.dir, lit ? 1.3 : 1.15, lit ? 0.26 : 0.23, lit);
                }
              }
              gl.disable(gl.BLEND);
              /* The sphere's texture unit is shared; leave it bound the way
                 the next frame's video upload expects to find it. */
              gl.bindTexture(gl.TEXTURE_2D, texture);
            }
          }
        });

        xrSession.addEventListener("end", () => {
          for (const item of xr?.menu.items || []) gl.deleteTexture(item.texture);
          if (xr?.menu.chipTexture) gl.deleteTexture(xr.menu.chipTexture);
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
          dir: markerDirection(Number(marker.u), Number(marker.v)),
        }));
      if (xr) {
        xr.markers = headsetMarkers;
        /* The pin somebody was looking at may have just been removed; keeping
           the old object would light a ring that is no longer in the list. */
        xr.looking = headsetMarkers.find((marker) => marker.id === xr.looking?.id) || null;
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
