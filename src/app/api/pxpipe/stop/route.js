import { NextResponse } from "next/server";
import { IS_ANDROID } from "@/lib/termux";
import { unloadPxpipe } from "@/lib/pxpipe/loader.js";
import { getPxpipeStatus } from "@/lib/pxpipe/service.js";

export const dynamic = "force-dynamic";

// "Stop" in library mode = drop the in-process module; requests fail open to
// uncompressed passthrough until it is started again.
export async function POST() {
  if (IS_ANDROID) {
    return NextResponse.json(
      { error: "Not supported on Android/Termux", code: "ANDROID_UNSUPPORTED" },
      { status: 409 }
    );
  }
  try {
    const wasLoaded = unloadPxpipe();
    return NextResponse.json({ stopped: wasLoaded, ...getPxpipeStatus() });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
