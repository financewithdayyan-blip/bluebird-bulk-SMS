import { NextResponse } from 'next/server';
import { get } from '@vercel/edge-config';

export const config = { matcher: '/welcome' };

export default async function proxy() {
  const greeting = await get('greeting');
  return NextResponse.json(greeting ?? null);
}
