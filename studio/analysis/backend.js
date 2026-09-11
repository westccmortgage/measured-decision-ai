/* Analysis uses the same project, accounts and storage as the Studio.
 * A preview URL previews code; it must not select another Supabase project.
 * config.js remains the single source of deployment configuration.
 */
export function backendFor(_hostname, production) {
  return Object.freeze({
    name: "Measured Decision AI",
    supabaseUrl: production?.supabaseUrl ?? "",
    publishableKey: production?.supabasePublishableKey ?? "",
    storageBucket: production?.storageBucket ?? "property-evidence",
    database: String(production?.supabaseUrl ?? "").replace(/^https:\/\//, "").split(".")[0],
    note: "Your existing Measured Decision workspace, accounts and files.",
  });
}
