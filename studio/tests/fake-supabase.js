/* A Supabase stand-in, so the Studio can be driven in a browser without a
 * network, an account, or a project to pollute.
 *
 * It is deliberately dumb: it answers queries from a fixed dataset and records
 * every write. The point is not to reimplement Postgres — it is to let the real
 * UI run against a known world so a test can assert what the screen says about
 * it. Anything the UI asks for that this does not know returns empty, which is
 * itself a useful signal: a screen that breaks on an empty answer is a screen
 * that will break on a new project.
 *
 * Seed data is set by the test through window.__seed before the page scripts run.
 */
(() => {
  const seed = window.__seed || {};
  const rows = seed.rows || {};
  window.__writes = [];
  window.__rpcCalls = [];

  const result = (data, error = null) => Promise.resolve({ data, error, count: Array.isArray(data) ? data.length : null });

  function builder(table) {
    let set = [...(rows[table] || [])];
    const api = {
      select(_cols, opts) {
        if (opts && opts.head) return result(null);
        return api;
      },
      eq(col, val) { set = set.filter((r) => r[col] === val); return api; },
      neq(col, val) { set = set.filter((r) => r[col] !== val); return api; },
      is(col, val) { set = set.filter((r) => (val === null ? r[col] == null : r[col] === val)); return api; },
      not(col, _op, val) { set = set.filter((r) => (val === null ? r[col] != null : r[col] !== val)); return api; },
      in(col, vals) { set = set.filter((r) => vals.includes(r[col])); return api; },
      order() { return api; },
      limit(n) { set = set.slice(0, n); return api; },
      maybeSingle() { return result(set[0] || null); },
      single() { return set.length ? result(set[0]) : result(null, { message: "no rows" }); },
      insert(payload) {
        const list = Array.isArray(payload) ? payload : [payload];
        list.forEach((r, i) => {
          const row = { id: `${table}-new-${window.__writes.length}-${i}`, ...r };
          (rows[table] ||= []).push(row);
          window.__writes.push({ table, op: "insert", row });
          set = [row];
        });
        return api;
      },
      update(patch) {
        set.forEach((r) => Object.assign(r, patch));
        window.__writes.push({ table, op: "update", patch, count: set.length });
        return api;
      },
      delete() { window.__writes.push({ table, op: "delete", count: set.length }); return api; },
      then(resolve, reject) { return result(set).then(resolve, reject); },
    };
    return api;
  }

  const session = seed.session === null ? null : (seed.session || {
    user: { id: "user-1", email: "owner@example.com" },
    access_token: "test",
  });

  window.supabase = {
    createClient() {
      return {
        auth: {
          getSession: () => Promise.resolve({ data: { session }, error: null }),
          onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
          signOut: () => Promise.resolve({ error: null }),
          signInWithPassword: () => Promise.resolve({ data: { session }, error: null }),
          signInWithOtp: () => Promise.resolve({ error: null }),
          signInWithOAuth: () => Promise.resolve({ error: null }),
          resetPasswordForEmail: () => Promise.resolve({ error: null }),
          updateUser: () => Promise.resolve({ error: null }),
        },
        from: builder,
        rpc(name, args) {
          window.__rpcCalls.push({ name, args });
          /* A few RPCs return rows rather than a boolean, and a screen built on
             the wrong shape breaks only in production. Answer in the shape the
             function actually answers in. */
          if (seed.rpc && Object.prototype.hasOwnProperty.call(seed.rpc, name)) {
            return result(seed.rpc[name]);
          }
          if (name === "removed_projects") return result([]);
          return result(true);
        },
        functions: {
          invoke(name, opts) {
            window.__rpcCalls.push({ name, args: opts?.body });
            /* A capture with no playable URL is not spatial, so without this the
               whole 360 half of the product looks absent and the test reports a
               fault that only exists in the harness. */
            if (opts?.body?.operation === "get_url") {
              /* Shaped like the real thing, and deliberately NOT a blob: URL.
                 It used to be one, and blob: URLs belong to the page and never
                 expire — so the Studio's freshness check short-circuited and
                 the whole "this signature is an hour old" path was invisible to
                 every test. A stand-in that cannot fail the way production
                 fails is a stand-in that proves nothing.
                 The counter makes each renewal distinguishable from the last. */
              window.__signCount = (window.__signCount || 0) + 1;
              return result({
                signed_url: `https://storage.test/evidence/${opts.body.record_id}?sig=${window.__signCount}`,
                expires_in: 3600,
              });
            }
            return result({});
          },
        },
        storage: { from: () => ({ createSignedUrl: () => result({ signedUrl: "" }), remove: () => result([]) }) },
        channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
        removeChannel: () => {},
      };
    },
  };
})();
