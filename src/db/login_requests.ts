import { supabase } from "./client.js";

// Helpers for the self-service wechat bind flow (wechat_login_requests is
// service-role-update only; this worker writes QR + status back).

export interface LoginRequest {
  id: string;
  guest_id: string;
}

export async function claimPendingRequest(): Promise<LoginRequest | null> {
  const { data, error } = await supabase
    .from("wechat_login_requests")
    .select("id, guest_id")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(error.message);
  const r = (data ?? [])[0] as LoginRequest | undefined;
  if (!r) return null;

  const { data: upd, error: uerr } = await supabase
    .from("wechat_login_requests")
    .update({ status: "awaiting_scan" })
    .eq("id", r.id)
    .eq("status", "pending")
    .select("id");
  if (uerr) throw new Error(uerr.message);
  if (!upd || upd.length === 0) return null; // taken by another worker
  return { id: r.id, guest_id: r.guest_id };
}

export async function updateQr(id: string, dataUrl: string): Promise<void> {
  await supabase.from("wechat_login_requests").update({ qr_png: dataUrl, status: "awaiting_scan" }).eq("id", id);
}

export async function setRequestStatus(id: string, status: string, errorText?: string): Promise<void> {
  await supabase.from("wechat_login_requests").update({ status, error_text: errorText ?? null }).eq("id", id);
}

export async function setRequestSuccess(id: string, guestAccountId: string): Promise<void> {
  await supabase
    .from("wechat_login_requests")
    .update({ status: "success", guest_account_id: guestAccountId, qr_png: null, error_text: null })
    .eq("id", id);
}
