import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newWorkspace } from "./helpers/fixtures";
import { cleanSecret, decrypt, deleteSecret, encrypt, getSecret, secretStatus, setSecret } from "@/lib/secrets";
import { getAiProvider } from "@/lib/providers/ai";
import { db, schema } from "@/db";

describe("API keys saved in Settings", () => {
  it("round-trips encrypted and never stores plaintext", async () => {
    const s = await newWorkspace();
    const key = "sk-proj-TestKeyValue1234567890abcdWXYZ";
    await setSecret(s.workspaceId, s.userId, "openai_api_key", key);
    expect(await getSecret(s.workspaceId, "openai_api_key")).toBe(key);
    const [row] = await db.select().from(schema.workspaceSecrets).where(eq(schema.workspaceSecrets.workspaceId, s.workspaceId));
    expect(row.ciphertext).not.toContain("TestKeyValue");
    expect(row.last4).toBe("WXYZ");
    expect(await secretStatus(s.workspaceId)).toMatchObject({ openai_api_key: { source: "app", last4: "WXYZ" }, tavily_api_key: { source: null } });
  });

  it("is isolated per workspace and removable", async () => {
    const a = await newWorkspace();
    const b = await newWorkspace();
    await setSecret(a.workspaceId, a.userId, "tavily_api_key", "tvly-abcdefghijklmnop");
    expect(await getSecret(b.workspaceId, "tavily_api_key")).toBeNull();
    await deleteSecret(a.workspaceId, "tavily_api_key");
    expect(await getSecret(a.workspaceId, "tavily_api_key")).toBeNull();
  });

  it("strips whitespace and control characters from pasted keys", () => {
    expect(cleanSecret("  sk-abc\u0016def\n ghi\t")).toBe("sk-abcdefghi");
  });

  it("detects tampering", () => {
    const enc = encrypt("secret-value-123456");
    expect(decrypt(enc)).toBe("secret-value-123456");
    const [iv, tag, data] = enc.split(".");
    const bad = [iv, tag, Buffer.from("tampered!").toString("base64")].join(".");
    expect(() => decrypt(bad)).toThrow();
    expect(data).toBeTruthy();
  });

  it("makes the AI provider use the saved key instead of reporting not configured", async () => {
    const s = await newWorkspace();
    await expect(getAiProvider(s.workspaceId)).rejects.toMatchObject({ kind: "not_configured" });
    await setSecret(s.workspaceId, s.userId, "openai_api_key", "sk-proj-abcdefghijklmnopqrstuvwxyz");
    expect((await getAiProvider(s.workspaceId)).name).toBe("OpenAI");
  });
});
