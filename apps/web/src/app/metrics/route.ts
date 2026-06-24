export const dynamic = 'force-dynamic';

import { registry } from '../../lib/metrics';

export async function GET(): Promise<Response> {
  return new Response(await registry.metrics(), {
    headers: { 'Content-Type': registry.contentType },
  });
}
