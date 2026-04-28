import { NextResponse } from "next/server";
import type { EngineOption } from "@/lib/engine-options";
import { FALLBACK_ENGINES } from "@/lib/engine-options";

interface InferenceEndpoint {
  id: string;
  engine_name?: string;
}

interface AdminPluginsResponse {
  inference: InferenceEndpoint[];
}

export const revalidate = 30; // 30-second cache

export async function GET(): Promise<NextResponse<EngineOption[]>> {
  const adminUrl = process.env.CORE_ADMIN_URL ?? "http://localhost:8080";
  try {
    const response = await fetch(`${adminUrl}/admin/plugins`, {
      next: { revalidate: 30 },
    });
    if (!response.ok) {
      return NextResponse.json(FALLBACK_ENGINES);
    }
    const data: AdminPluginsResponse = await response.json() as AdminPluginsResponse;
    const engines: EngineOption[] = data.inference.map((ep) => ({
      id: ep.id,
      label: ep.engine_name ? `${ep.engine_name} (${ep.id})` : ep.id,
    }));
    if (engines.length === 0) {
      return NextResponse.json(FALLBACK_ENGINES);
    }
    return NextResponse.json(engines);
  } catch {
    return NextResponse.json(FALLBACK_ENGINES);
  }
}
