// RIGHT (Next.js 14)
import { NextRequest, NextResponse } from 'next/server';
import { headers } from 'next/headers';
import { Octokit } from '@octokit/rest';
import Fuse from 'fuse.js';
import { promises as fs } from 'fs';
import path from 'path';

const API_KEY = process.env.API_KEY!;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN!;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yourusername/my-search-api';
const GITHUB_FILE = 'data.json';
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const DATA_PATH = path.join(process.cwd(), 'data.json');

async function checkAuth(req: NextRequest) {
  if (headers().get('X-API-Key') !== API_KEY) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 });
  }
  return null;
}

async function loadData() {
  try {
    await fs.access(DATA_PATH);
    return JSON.parse(await fs.readFile(DATA_PATH, 'utf8'));
  } catch {
    const { data } = await octokit.rest.repos.getContent({
      owner: GITHUB_REPO.split('/')[0],
      repo: GITHUB_REPO.split('/')[1],
      path: GITHUB_FILE,
    });
    return JSON.parse(Buffer.from((data as any).content, 'base64').toString());
  }
}

async function saveData(data: any) {
  const content = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  await octokit.rest.repos.createOrUpdateFileContents({
    owner: GITHUB_REPO.split('/')[0],
    repo: GITHUB_REPO.split('/')[1],
    path: GITHUB_FILE,
    message: `Fuzzy search data update (${new Date().toISOString()})`,
    content,
  });
  await fs.writeFile(DATA_PATH, JSON.stringify(data, null, 2));
}

export async function GET(req: NextRequest) {
  const authError = await checkAuth(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const action = searchParams.get('action');
  const q = searchParams.get('q') || '';
  const tagsParam = searchParams.get('tags') || '';
  const tags = tagsParam ? tagsParam.split(',').filter(Boolean) : [];
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '10');
  const offset = (page - 1) * limit;

  const data = await loadData();
  data.items = data.items || [];
  data.tags = data.tags || {};
  data.itemTags = data.itemTags || {};
  data.userStats = data.userStats || {};

  if (action === 'tags') return NextResponse.json(Object.keys(data.tags));

  // Hybrid fuzzy search (perf-optimized)
  let results = [];
  const searchableItems = data.items.map(item => ({
    ...item,
    tagsStr: (data.itemTags[item.id] || []).join(' ')
  }));

  if (q) {
    if (searchableItems.length > 5000 || q.length > 10) {
      // Coarse filter + Fuse (fast for large datasets)
      const coarse = searchableItems.filter(item =>
        item.title?.toLowerCase().includes(q.slice(0, 4)) ||
        item.description?.toLowerCase().includes(q.slice(0, 4)) ||
        item.tagsStr?.toLowerCase().includes(q.slice(0, 4))
      );
      const fuse = new Fuse(coarse, {
        keys: ['title', 'description', 'tagsStr'],
        threshold: 0.4,
        ignoreLocation: true
      });
      results = fuse.search(q).map((r: any) => r.item);
    } else {
      // Full Fuse (small/fast)
      const fuse = new Fuse(searchableItems, {
        keys: ['title', 'description', 'tagsStr'],
        threshold: 0.4,
        ignoreLocation: true,
        useExtendedSearch: true
      });
      results = fuse.search(q).map((r: any) => r.item);
    }
  } else {
    results = searchableItems;
  }

  // Tag filter
  results = results.filter((item: any) =>
    !tags.length || tags.every(t => data.itemTags[item.id]?.includes(t))
  );

  // Featured/ad boost sort
  results.sort((a: any, b: any) => {
    const aScore = (a.is_featured ? 100 : 0) + (a.is_ad ? 50 + (a.ad_priority || 0) * 10 : 0);
    const bScore = (b.is_featured ? 100 : 0) + (b.is_ad ? 50 + (b.ad_priority || 0) * 10 : 0);
    return bScore - aScore;
  });

  return NextResponse.json({
    results: results.slice(offset, offset + limit),
    page, limit, total: results.length
  });
}

export async function POST(req: NextRequest) {
  const authError = await checkAuth(req);
  if (authError) return authError;

  const body = await req.json();
  const { title, description, url, tags = [], is_featured = false, is_ad = false, ad_priority = 0, id, user_id } = body;

  let data = await loadData();
  const newId = id || (data.items?.length + 1 || 1).toString();

  data.items = (data.items || []).filter((i: any) => i.id !== newId);
  data.items.push({
    id: newId, title, description, url, is_featured, is_ad, ad_priority,
    created_at: new Date().toISOString(), added_by: user_id
  });

  tags.forEach((tag: string) => { data.tags[tag] = true; });
  data.itemTags[newId] = tags;

  if (user_id) {
    data.userStats[user_id] = data.userStats[user_id] || { adds: 0, lastAdd: '' };
    data.userStats[user_id].adds += 1;
    data.userStats[user_id].lastAdd = new Date().toISOString();
  }

  await saveData(data);
  return NextResponse.json({ success: true, id: newId });
}

export async function DELETE(req: NextRequest) {
  const authError = await checkAuth(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'ID required' }, { status: 400 });

  const data = await loadData();
  data.items = (data.items || []).filter((item: any) => item.id !== id);
  delete data.itemTags[id];

  await saveData(data);
  return NextResponse.json({ success: true });
}
