export default [
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { window: "readonly", document: "readonly", localStorage: "readonly", navigator: "readonly", console: "readonly", URLSearchParams: "readonly", fetch: "readonly", XMLHttpRequest: "readonly", crypto: "readonly", Blob: "readonly", File: "readonly", FileReader: "readonly", URL: "readonly", Event: "readonly", CustomEvent: "readonly", setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly", requestAnimationFrame: "readonly", matchMedia: "readonly", HTMLElement: "readonly", Image: "readonly", Audio: "readonly", AbortController: "readonly", TextDecoder: "readonly", TextEncoder: "readonly", DataTransfer: "readonly", alert: "readonly", history: "readonly", location: "readonly", DOMParser: "readonly", getComputedStyle: "readonly", IntersectionObserver: "readonly", ResizeObserver: "readonly", MutationObserver: "readonly", performance: "readonly", structuredClone: "readonly", screen: "readonly", DeviceOrientationEvent: "readonly", WebSocket: "readonly", Notification: "readonly" },
    },
    rules: {
      "no-shadow": "error",
      "no-use-before-define": ["error", { functions: false, classes: false, variables: true }],
      "no-undef": "off",
      "no-unused-vars": "off",
    },
  },
];
