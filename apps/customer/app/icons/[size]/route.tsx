// App icons generated on request (no binary files in the repo): brand green with "PB" in gold.
import { ImageResponse } from 'next/og';

const SIZES = new Set([180, 192, 512]);

export async function GET(_request: Request, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return new Response('Not found', { status: 404 });
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#146F3B',
        color: '#F5A623',
        fontSize: size * 0.42,
        fontWeight: 700,
      }}
    >
      PB
    </div>,
    { width: size, height: size },
  );
}
