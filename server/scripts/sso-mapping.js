"use strict";

const { pool } = require("../src/storage/pool");
const { Repository } = require("../src/storage/repository");

/**
 * Kelola mapping Azure AD → role + scope middleware (tabel sso_role_mappings).
 *
 *   npm run sso:mapping -- list
 *   npm run sso:mapping -- set role MW.Station.LBB viewer "*:LBB" "Petugas Stasiun Lebak Bulus"
 *   npm run sso:mapping -- set group 3f2a...-object-id-grup operator "scada:*,nms:*"
 *   npm run sso:mapping -- disable role MW.Viewer
 *   npm run sso:mapping -- remove role MW.Station.LBB
 *
 * claim_type `role`  = nilai App Role di app registration API (disarankan).
 * claim_type `group` = object ID grup Azure AD (butuh klaim groups di token; hati-hati batas 200 grup).
 * Perubahan berlaku di middleware yang sedang berjalan dalam ±60 detik.
 */
async function main() {
  const [cmd, claimType, claimValue, role, scopesArg, description] =
    process.argv.slice(2);
  const repo = new Repository(pool);
  const ensureType = () => {
    if (!["role", "group"].includes(claimType ?? "") || !claimValue)
      throw new Error("claim_type harus role|group dan claim_value wajib");
  };

  switch (cmd) {
    case "list": {
      const rows = await repo.listSsoMappings();
      console.table(
        rows.map((r) => ({
          type: r.claimType,
          value: r.claimValue,
          role: r.role,
          scopes: r.scopes.join(","),
          active: r.active,
          description: r.description ?? "",
        })),
      );
      break;
    }
    case "set": {
      ensureType();
      if (!["viewer", "operator", "admin"].includes(role ?? "") || !scopesArg)
        throw new Error("role (viewer|operator|admin) dan scope wajib");
      const scopes = scopesArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = scopes.filter(
        (s) => !/^(\*|scada|nms|pids):(\*|[A-Za-z0-9]{2,10})$/.test(s),
      );
      if (bad.length)
        throw new Error(
          `scope tidak valid: ${bad.join(", ")} (format sumber:stasiun)`,
        );
      console.log(
        await repo.upsertSsoMapping({
          claimType,
          claimValue,
          role,
          scopes,
          description,
          active: true,
        }),
      );
      break;
    }
    case "disable": {
      ensureType();
      const current = (await repo.listSsoMappings()).find(
        (m) => m.claimType === claimType && m.claimValue === claimValue,
      );
      if (!current) throw new Error("mapping tidak ditemukan");
      console.log(await repo.upsertSsoMapping({ ...current, active: false }));
      break;
    }
    case "remove":
      ensureType();
      console.log(
        (await repo.deleteSsoMapping(claimType, claimValue))
          ? "dihapus"
          : "tidak ditemukan",
      );
      break;
    default:
      console.error(
        "Perintah: list | set <role|group> <nilai> <role> <scope,...> [deskripsi] | disable <role|group> <nilai> | remove <role|group> <nilai>",
      );
      process.exitCode = 1;
  }
  await pool.end();
}

main().catch(async (err) => {
  console.error(err.message);
  await pool.end();
  process.exit(1);
});
