import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkExportCsp, cspProblems, injectCsp, inlineScripts, writeExportCsp } from '../../../scripts/export-csp.mjs';

const BOOTSTRAP = '(self.__next_f=self.__next_f||[]).push([0])';
const FLIGHT = 'self.__next_f.push([1,"1:\\"$Sreact.fragment\\"\\n2:I[47257,[\\"/_next/static/chunks/a.js\\"]]\\n"])';

/** A page as Next's static export writes it: charset first, chunk scripts, inline bootstrap and flight data. */
const PAGE =
  '<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/>' +
  '<meta name="viewport" content="width=device-width"/>' +
  '<link rel="stylesheet" href="/_next/static/chunks/a.css"/>' +
  '<script src="/_next/static/chunks/a.js" async=""></script>' +
  '<title>QuickScan</title></head><body><div>Gallery</div>' +
  `<script>${BOOTSTRAP}</script><script>${FLIGHT}</script>` +
  '<script src="/_next/static/chunks/b.js" noModule=""></script></body></html>';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

function policyOf(html: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"\/>/.exec(html);
  if (!match) throw new Error('no CSP meta');
  return match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

function scriptSrc(policy: string): string[] {
  const part = policy.split(';').find((p) => p.trim().startsWith('script-src '));
  return part ? part.trim().split(/\s+/).slice(1) : [];
}

describe('injectCsp', () => {
  it('puts the policy first in <head>, right after <meta charset>', () => {
    const html = injectCsp(PAGE);
    expect(html.startsWith('<!DOCTYPE html><html lang="en"><head><meta charSet="utf-8"/><meta http-equiv="Content-Security-Policy" content="')).toBe(true);
    // Nothing that loads or runs comes before it
    const metaAt = html.indexOf('http-equiv="Content-Security-Policy"');
    expect(html.indexOf('<script')).toBeGreaterThan(metaAt);
    expect(html.indexOf('<link')).toBeGreaterThan(metaAt);
    expect(html).toContain('<meta name="referrer" content="no-referrer"/>');
    expect(
      html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*"\/><meta name="referrer" content="no-referrer"\/>/, '')
    ).toBe(PAGE);
  });

  it('allows exactly the inline scripts, by their SHA-256 hashes, and nothing inline or eval', () => {
    const policy = policyOf(injectCsp(PAGE));
    expect(scriptSrc(policy)).toEqual(["'self'", `'sha256-${sha256(BOOTSTRAP)}'`, `'sha256-${sha256(FLIGHT)}'`]);
    expect(scriptSrc(policy)).not.toContain("'unsafe-inline'");
    expect(scriptSrc(policy)).not.toContain("'unsafe-eval'");
    expect(scriptSrc(policy)).not.toContain("'strict-dynamic'");
  });

  it('hashes the script body byte for byte, including non-ASCII text', () => {
    const body = 'self.__next_f.push([1,"Zurück — “Ü”"])';
    const page = PAGE.replace(FLIGHT, body);
    expect(scriptSrc(policyOf(injectCsp(page)))).toContain(`'sha256-${sha256(body)}'`);
  });

  it('mirrors the web policy, minus what a <meta> policy cannot carry', () => {
    const policy = policyOf(injectCsp(PAGE, { supabaseUrl: 'https://abc.supabase.co', upgradeInsecureRequests: true }));
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("worker-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("connect-src 'self' https://abc.supabase.co wss://abc.supabase.co https: http://localhost:* http://127.0.0.1:*");
    expect(policy).not.toContain('frame-ancestors');
    expect(policy).toMatch(/; upgrade-insecure-requests$/);
  });

  it('works without <meta charset>, and refuses a page without <head> or with a policy already', () => {
    const plain = '<html><head><title>x</title></head><body><script>1</script></body></html>';
    expect(injectCsp(plain)).toMatch(/^<html><head><meta http-equiv="Content-Security-Policy" /);
    expect(() => injectCsp('<html><body></body></html>')).toThrow(/no <head>/);
    expect(() => injectCsp(injectCsp(PAGE))).toThrow(/already/);
  });

  it('finds inline scripts only, not script files', () => {
    expect(inlineScripts(PAGE)).toEqual([BOOTSTRAP, FLIGHT]);
  });
});

describe('cspProblems', () => {
  it('passes an injected page', () => {
    expect(cspProblems(injectCsp(PAGE))).toEqual([]);
  });

  it('reports a page without a policy', () => {
    expect(cspProblems(PAGE)).toEqual(['expected one CSP <meta>, found 0']);
  });

  it('reports an inline script added after the hashes were computed', () => {
    const tampered = injectCsp(PAGE).replace('</body>', '<script>alert(1)</script></body>');
    expect(cspProblems(tampered)).toEqual([`inline script without its hash ${sha256('alert(1)')}: "alert(1)"`]);
  });

  it('reports a policy that is not first in <head>', () => {
    const html = injectCsp(PAGE);
    const meta = /<meta http-equiv="Content-Security-Policy" content="[^"]*"\/>/.exec(html)![0];
    const moved = html.replace(meta, '').replace('<title>', `${meta}<title>`);
    expect(cspProblems(moved)).toContain('the CSP <meta> is not first in <head>');
  });

  it("reports 'unsafe-inline' or 'unsafe-eval' in script-src", () => {
    const html = injectCsp(PAGE).replace("script-src 'self'", "script-src 'self' 'unsafe-inline' 'unsafe-eval'");
    expect(cspProblems(html)).toEqual(["script-src allows 'unsafe-inline'", "script-src allows 'unsafe-eval'"]);
  });
});

describe('writeExportCsp / checkExportCsp', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('injects every page of an export, nested ones too, and the check passes', () => {
    dir = mkdtempSync(join(tmpdir(), 'export-csp-'));
    mkdirSync(join(dir, 'doc'));
    writeFileSync(join(dir, 'index.html'), PAGE);
    writeFileSync(join(dir, 'doc', 'index.html'), PAGE.replace(FLIGHT, 'self.__next_f.push([1,"doc"])'));
    writeFileSync(join(dir, 'manifest.webmanifest'), '{}');
    expect(checkExportCsp(dir)).toHaveLength(2);

    expect(writeExportCsp(dir)).toBe(2);
    expect(checkExportCsp(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8')).toBe('{}');
  });

  it('fails on an empty export', () => {
    dir = mkdtempSync(join(tmpdir(), 'export-csp-'));
    expect(checkExportCsp(dir)).toEqual([`no pages in ${dir}`]);
  });
});
