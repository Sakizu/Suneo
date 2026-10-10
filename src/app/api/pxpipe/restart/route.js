import { NextResponse } from "next/server";
import { IS_ANDROID } from "@/lib/termux";
import { unloadPxpipe, loadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// Reload the in-process module (picks up an upgraded install without a server restart).
export async function POST() {
  if (IS_ANDROID) {
    return NextResponse.json(
      { error: "Not supported on Android/Termux", code: "ANDROID_UNSUPPORTED" },
      { status: 409 }
    );
  }
  try {
    unloadPxpipe();
    await loadPxpipe();
    return NextResponse.json(getPxpipeStatus());
  } catch (error) {
    return NextResponse.json({ error: error.message, code: error.code || null }, { status: 500 });
  }
}
