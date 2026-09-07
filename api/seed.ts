import type { VercelRequest, VercelResponse } from '@vercel/node';
export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(410).json({ error: 'demo_data_removed', message: 'Open a connected Smart Productivity sub-account to use real data.' });
}
