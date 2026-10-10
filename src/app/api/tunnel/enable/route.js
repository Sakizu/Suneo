import { NextResponse } from "next/server";
import { IS_ANDROID } from "@/lib/termux";
import { enableTunnel } from "@/lib/tunnel";
import { getSettings } from "@/lib/localDb";
import { configureTunnelMonitoring } from "@/shared/services/initializeApp";

const DNS_WARMUP_DELAY_MS = 8000;

export async function POST() {
  if (IS_ANDROID) {
    return NextResponse.json(
      { error: "Not supported on Android/Termux", code: "ANDROID_UNSUPPORTED" },
      { status: 409 }
    );
  }
  try {
    const result = await enableTunnel();
    getSettings()
      .then(configureTunnelMonitoring)
      .catch((error) => console.warn("Tunnel monitor start failed:", error.message));
    // Wait for DNS warmup to propagate at Cloudflare edge after tunnel registered
    await new Promise((r) => setTimeout(r, DNS_WARMUP_DELAY_MS));
    return NextResponse.json(result);
  } catch (error) {
    console.error("Tunnel enable error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
