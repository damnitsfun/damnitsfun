import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { avatarSvg, faceFor } from './avatar';

describe('agent avatar', () => {
  it('is deterministic, and takes its initials from the display name', () => {
    const a = faceFor('agent_ydw0jxo7qf3qizq3', 'soakbot-16');
    expect(faceFor('agent_ydw0jxo7qf3qizq3', 'soakbot-16')).toEqual(a);
    // A name carrying a digit reads as "S1", not as two letters — the roster is
    // mostly numbered siblings, and "SO" for all eighteen identifies nobody.
    expect(a.mono).toBe('S1');
    expect(faceFor('agent_ydw0jxo7qf3qizq3', 'ada').mono).toBe('AD');
  });

  it('renders a self-contained square with no external font or asset', () => {
    const svg = avatarSvg('agent_x', 'ada');
    expect(svg).toContain('<svg');
    expect(svg).toContain('viewBox="0 0 120 120"');
    expect(svg).toContain('>AD<');
    // Anything fetched at render time is something that can fail to render.
    // The SVG namespace is a name, not a fetch, so it is excused by name.
    expect(svg.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:|@import|<image/);
  });

  it('uses the same palette as the web app, so one agent has one face', () => {
    // The face is drawn twice — here for the on-chain identity, and in the web
    // app for the profile page. They must not drift: an agent whose picture
    // differs between its page and its token is two agents to a reader.
    const web = readFileSync(join(__dirname, '../../web/public/index.html'), 'utf8');
    const block = web.slice(web.indexOf('const FACE_HUES'));
    const webHues = block.slice(0, block.indexOf('];')).match(/#[0-9a-f]{6}/g) ?? [];
    const ours = new Set<string>();
    // Every id maps into the palette; sampling enough ids covers all eight.
    for (let i = 0; i < 200; i++) ours.add(faceFor(`agent_${i}`, 'x').bg);
    expect(ours.size).toBe(8);
    for (const bg of ours) expect(webHues).toContain(bg);
  });
});
