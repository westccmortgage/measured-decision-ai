/* Asking the headset what it can do, rather than assuming.
 *
 * The sphere is drawn here in the browser as a coloured room: each wall a
 * different colour carrying its own direction, a light ceiling and a dark
 * floor. That is not decoration — it is the only way to tell, from inside a
 * headset, whether the sphere is mapped the right way round. A capture that
 * renders with north behind you, or with the ceiling underfoot, looks fine on a
 * laptop and is obviously wrong the moment somebody stands in it.
 *
 * Rendering is a ray cast per pixel rather than sphere geometry. WebXR hands
 * back whatever projection the device uses — asymmetric, per eye, and not
 * something to guess at — and unprojecting the pixel handles all of it without
 * caring what shape the frustum is.
 */
(() => {
  const canvas = document.getElementById("stage");
  const enter = document.getElementById("enter");
  const flat = document.getElementById("flat");
  const exit = document.getElementById("exit");
  const log = document.getElementById("log");
  const capabilities = document.getElementById("capabilities");

  const lines = [];
  const say = (text) => {
    lines.push(text);
    log.textContent = lines.join("\n");
  };

  const row = (label, value, state) => {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    dd.className = state || "";
    capabilities.append(dt, dd);
  };

  /* ------------------------------------------------ what the browser admits */

  const secure = window.isSecureContext;
  row("Secure page (HTTPS)", secure ? "yes" : "no", secure ? "yes" : "no");
  row("navigator.xr", "xr" in navigator ? "present" : "missing", "xr" in navigator ? "yes" : "no");

  const gl = canvas.getContext("webgl2", { xrCompatible: true, antialias: false })
    || canvas.getContext("webgl", { xrCompatible: true, antialias: false });
  row("WebGL", gl ? (gl instanceof WebGL2RenderingContext ? "WebGL 2" : "WebGL 1") : "missing",
    gl ? "yes" : "no");

  /* The user agent is the one line that identifies which headset answered, and
     it is what makes a screenshot of this page worth anything to somebody
     reading it later. */
  say(`user agent: ${navigator.userAgent}`);
  say(`page: ${location.href}`);

  async function askDevice() {
    if (!("xr" in navigator)) {
      row("Immersive VR", "not supported", "no");
      enter.textContent = "This browser has no WebXR";
      enter.disabled = true;
      say("navigator.xr is missing, so no immersive session is possible here.");
      return;
    }
    for (const mode of ["immersive-vr", "immersive-ar"]) {
      let supported = "unknown";
      let state = "unknown";
      try {
        supported = (await navigator.xr.isSessionSupported(mode)) ? "yes" : "no";
        state = supported === "yes" ? "yes" : "no";
      } catch (error) {
        supported = `asking failed — ${error.name || "error"}`;
        say(`isSessionSupported(${mode}) threw: ${error}`);
      }
      row(mode === "immersive-vr" ? "Immersive VR" : "Immersive AR", supported, state);
      if (mode === "immersive-vr") {
        enter.disabled = supported !== "yes";
        enter.textContent = supported === "yes"
          ? "Stand inside the sphere"
          : "Immersive VR is not offered here";
      }
    }
    if (!enter.disabled) say("Immersive VR is offered. Press the button to start a session.");
  }

  if (!gl) {
    say("No WebGL context, so nothing can be drawn at all.");
    enter.disabled = true;
    flat.disabled = true;
    return;
  }

  /* ------------------------------------------------------- the test pattern */

  /* A room rather than a gradient: walls that name their own direction, a light
     ceiling and a dark floor. Anything mirrored, rotated or upside down is then
     obvious from inside instead of plausible. */
  function testPattern() {
    const width = 2048;
    const height = 1024;
    const surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    const paint = surface.getContext("2d");

    /* Wall centres, not wall edges, sit on the cardinal directions.
       An equirectangular image puts straight ahead at its middle, so laying
       four walls out from the left edge puts a seam exactly where "forward"
       is — and every sample of it comes back a blend of two walls, which is
       neither a pass nor a useful failure. Each wall is centred on the
       direction it names instead. */
    const walls = [
      { label: "BEHIND", centre: 0.0, colour: "#6a2440" },
      { label: "LEFT", centre: 0.25, colour: "#2c6a44" },
      { label: "FRONT", centre: 0.5, colour: "#1d6a8a" },
      { label: "RIGHT", centre: 0.75, colour: "#7a5320" },
    ];
    walls.forEach((wall) => {
      paint.fillStyle = wall.colour;
      const from = (wall.centre - 0.125) * width;
      // The wall centred on the seam is painted in both halves.
      paint.fillRect(from, 0, width / 4, height);
      if (from < 0) paint.fillRect(from + width, 0, width / 4, height);
    });

    // Ceiling and floor: the top and bottom bands of an equirectangular image.
    const cap = height * 0.18;
    paint.fillStyle = "#dfe9ee";
    paint.fillRect(0, 0, width, cap);
    paint.fillStyle = "#08131c";
    paint.fillRect(0, height - cap, width, cap);

    paint.textAlign = "center";
    paint.textBaseline = "middle";
    paint.fillStyle = "#ffffff";
    paint.font = "700 96px -apple-system, Helvetica, sans-serif";
    /* Above the horizon, not on it. A white label sitting exactly where somebody
       looks is the first thing any check of this pattern reads back, and it
       says nothing about which wall it is written on. */
    const labelY = height * 0.32;
    walls.forEach((wall) => {
      paint.fillText(wall.label, wall.centre * width, labelY);
      if (wall.centre === 0) paint.fillText(wall.label, width, labelY);
    });

    paint.fillStyle = "#08131c";
    paint.font = "700 64px -apple-system, Helvetica, sans-serif";
    paint.fillText("CEILING — you are looking up", width / 2, cap / 2);
    paint.fillStyle = "#dfe9ee";
    paint.fillText("FLOOR — you are looking down", width / 2, height - cap / 2);

    // The horizon, so a tilt shows up as a slope rather than a feeling.
    paint.strokeStyle = "rgba(255,255,255,0.55)";
    paint.lineWidth = 3;
    paint.beginPath();
    paint.moveTo(0, height / 2);
    paint.lineTo(width, height / 2);
    paint.stroke();

    return surface;
  }

  const VERTEX = `
    attribute vec2 corner;
    varying vec2 ndc;
    void main() {
      ndc = corner;
      gl_Position = vec4(corner, 0.0, 1.0);
    }`;

  /* Unproject the pixel, rotate it into the world, read the sphere. Doing it
     this way means the device's own projection is used exactly as given —
     asymmetric frusta and per-eye differences included — instead of being
     approximated by a field of view this code invented. */
  const FRAGMENT = `
    precision highp float;
    varying vec2 ndc;
    uniform mat4 invProjection;
    uniform mat3 viewRotation;
    uniform sampler2D sphere;
    const float PI = 3.141592653589793;
    void main() {
      vec4 eye = invProjection * vec4(ndc, -1.0, 1.0);
      vec3 direction = normalize(viewRotation * normalize(eye.xyz / eye.w));
      float u = atan(direction.x, -direction.z) / (2.0 * PI) + 0.5;
      float v = acos(clamp(direction.y, -1.0, 1.0)) / PI;
      gl_FragColor = texture2D(sphere, vec2(u, v));
    }`;

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      say(`shader failed: ${gl.getShaderInfoLog(shader)}`);
      return null;
    }
    return shader;
  }

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    say(`program failed: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, "corner");
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const uInvProjection = gl.getUniformLocation(program, "invProjection");
  const uViewRotation = gl.getUniformLocation(program, "viewRotation");

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, testPattern());

  /* --------------------------------------------------------- shared drawing */

  function invert(m) {
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

  /* The view matrix turns world into eye, so its rotation read the other way
     turns an eye ray back into the world. For a rotation, that is the
     transpose. */
  function rotationFromView(view) {
    return new Float32Array([
      view[0], view[4], view[8],
      view[1], view[5], view[9],
      view[2], view[6], view[10],
    ]);
  }

  function drawView(projection, viewMatrix) {
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(corner);
    gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniformMatrix4fv(uInvProjection, false, invert(projection));
    gl.uniformMatrix3fv(uViewRotation, false, rotationFromView(viewMatrix));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* ----------------------------------------------------------- immersive VR */

  let session = null;

  async function startImmersive() {
    enter.disabled = true;
    enter.textContent = "Starting…";
    try {
      session = await navigator.xr.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor", "bounded-floor"],
      });
      say("session started.");
    } catch (error) {
      say(`requestSession failed: ${error.name || ""} ${error.message || error}`);
      enter.disabled = false;
      enter.textContent = "Stand inside the sphere";
      return;
    }

    try {
      await gl.makeXRCompatible();
      const layer = new XRWebGLLayer(session, gl);
      session.updateRenderState({ baseLayer: layer });
      say(`framebuffer: ${layer.framebufferWidth}×${layer.framebufferHeight}`);

      let reference = null;
      for (const kind of ["local-floor", "local", "viewer"]) {
        try {
          reference = await session.requestReferenceSpace(kind);
          say(`reference space: ${kind}`);
          break;
        } catch (error) {
          say(`reference space ${kind} refused`);
        }
      }
      if (!reference) throw new Error("no reference space was offered");

      let reported = false;
      session.requestAnimationFrame(function frame(time, xrFrame) {
        if (!session) return;
        session.requestAnimationFrame(frame);
        const pose = xrFrame.getViewerPose(reference);
        if (!pose) return;
        const layerNow = session.renderState.baseLayer;
        gl.bindFramebuffer(gl.FRAMEBUFFER, layerNow.framebuffer);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        if (!reported) {
          reported = true;
          /* Two views is stereo, one is a single flat pane. That single number
             is the difference between standing in a room and looking at a
             photograph of one. */
          say(`views this frame: ${pose.views.length} (${pose.views.length >= 2 ? "stereo" : "monoscopic"})`);
        }
        for (const view of pose.views) {
          const viewport = layerNow.getViewport(view);
          gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
          drawView(view.projectionMatrix, view.transform.inverse.matrix);
        }
      });

      session.addEventListener("end", () => {
        session = null;
        enter.disabled = false;
        enter.textContent = "Stand inside the sphere";
        say("session ended.");
      });
    } catch (error) {
      say(`session could not be set up: ${error.message || error}`);
      try { await session.end(); } catch (_) { /* already gone */ }
      session = null;
      enter.disabled = false;
      enter.textContent = "Stand inside the sphere";
    }
  }

  /* ---------------------------------------------- the same sphere, flat, so
     the pattern can be checked before putting a headset on. */

  let flatRunning = false;
  let yaw = 0;
  let pitch = 0;

  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f; out[10] = (far + near) / (near - far);
    out[11] = -1; out[14] = (2 * far * near) / (near - far);
    return out;
  }

  /* Built from the direction the camera faces rather than written out by hand,
     because a sign slipped into a hand-written view matrix is invisible on a
     laptop and unmistakable from inside a headset.

     yaw 0 faces −Z, and yaw increasing turns to the right, which is +X. Those
     two sentences are the whole convention, and the test pins them to the
     walls that carry those names. */
  function lookMatrix() {
    const cp = Math.cos(pitch);
    const forward = [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
    const z = [-forward[0], -forward[1], -forward[2]];
    // right = up × back, with up as world +Y.
    let x = [z[2], 0, -z[0]];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0],
    ];
    // Column-major, as WebGL wants it.
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      0, 0, 0, 1,
    ]);
  }

  /* A seam for the test to drive the camera through. The probe is not the
     product, and reading pixels back is the only way to prove which way round
     the sphere is without a person in a headset. */
  window.__vrCheckLook = (nextYaw, nextPitch) => {
    yaw = nextYaw;
    pitch = Math.max(-1.5, Math.min(1.5, nextPitch));
  };

  function startFlat() {
    if (flatRunning) return;
    flatRunning = true;
    canvas.classList.add("showing");
    exit.classList.add("showing");
    const step = () => {
      if (!flatRunning) return;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      drawView(perspective(1.2, canvas.width / Math.max(1, canvas.height), 0.1, 100), lookMatrix());
      window.requestAnimationFrame(step);
    };
    step();
    say("flat preview running — drag to look around.");
  }

  function stopFlat() {
    flatRunning = false;
    canvas.classList.remove("showing");
    exit.classList.remove("showing");
  }

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  canvas.addEventListener("pointerdown", (event) => {
    dragging = true; lastX = event.clientX; lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (!dragging) return;
    yaw -= (event.clientX - lastX) * 0.004;
    pitch = Math.max(-1.5, Math.min(1.5, pitch + (event.clientY - lastY) * 0.004));
    lastX = event.clientX; lastY = event.clientY;
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach((name) =>
    canvas.addEventListener(name, () => { dragging = false; }));

  enter.addEventListener("click", startImmersive);
  flat.addEventListener("click", startFlat);
  exit.addEventListener("click", stopFlat);

  askDevice();
})();
