import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

/*
 * One version for every platform: package.json's `version` is the web app's, and Android's
 * versionName (android/app/build.gradle reads it). Xcode can't read package.json, so the iOS
 * project carries a copy in MARKETING_VERSION; bump both together.
 */

const root = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('app version', () => {
  const version = JSON.parse(read('package.json')).version as string;
  const project = read('ios/App/App.xcodeproj/project.pbxproj');

  it('is the same in the iOS project as in package.json', () => {
    const marketing = [...project.matchAll(/MARKETING_VERSION = ([^;]+);/g)].map((m) => m[1]);
    expect(marketing.length).toBeGreaterThan(0);
    expect(new Set(marketing)).toEqual(new Set([version]));
  });

  it('is read from package.json by the Android build', () => {
    expect(read('android/app/build.gradle')).toContain("rootProject.file('../package.json')");
  });

  it('ships the iOS app for iPhone only', () => {
    const families = [...project.matchAll(/TARGETED_DEVICE_FAMILY = ([^;]+);/g)].map((m) => m[1]);
    expect(families.length).toBeGreaterThan(0);
    expect(new Set(families)).toEqual(new Set(['1']));
    expect(read('ios/App/App/Info.plist')).not.toContain('~ipad');
  });
});
