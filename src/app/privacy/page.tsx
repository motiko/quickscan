import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { PRIVACY_CONTACT, PRIVACY_POLICY_UPDATED } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Privacy policy · QuickScan',
};

/*
 * The privacy policy the app stores link to (Google Play, App Store). It describes what the
 * code does: keep it in step with SECURITY.md and the store privacy answers
 * (docs/native/android.md, "Data safety answers") whenever a network destination, a stored
 * field or a third-party SDK changes.
 */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">{title}</h2>
      {children}
    </section>
  );
}

const list = 'list-disc space-y-1.5 pl-5';

export default function PrivacyPage() {
  const { name, email } = PRIVACY_CONTACT;
  return (
    <div className="flex min-h-screen flex-col bg-gray-50 dark:bg-neutral-950 pb-safe-offset-6">
      <header className="sticky top-0 z-20 bg-white dark:bg-neutral-900 px-4 shadow-xs pt-safe dark:shadow-none dark:border-b dark:border-neutral-800">
        <div className="flex h-14 items-center gap-2">
          <Link
            href="/settings"
            className="-ml-2 flex h-11 w-11 items-center justify-center rounded-full text-gray-900 dark:text-gray-100 hover:bg-gray-100 dark:hover:bg-neutral-800"
            aria-label="Back to settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"></polyline>
            </svg>
          </Link>
          <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100">Privacy policy</h1>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 space-y-8 p-4 text-[0.9375rem] leading-relaxed text-gray-700 dark:text-gray-300">
        <div className="space-y-3">
          <p className="text-sm text-gray-500 dark:text-gray-400">Last updated {PRIVACY_POLICY_UPDATED}</p>
          <p>
            QuickScan is a document scanner for the web, iPhone and Android. Your scans, their text and your
            settings stay on your device. You don&rsquo;t need an account. Nothing about you is used for ads or
            tracking, and the app contains no analytics.
          </p>
          <p>
            This policy covers the QuickScan apps on Google Play and the App Store and the web app at
            scantab.vercel.app. It says what leaves your device, and when.
          </p>
        </div>

        <Section title="Who is responsible">
          <p>
            {name} is responsible for QuickScan&rsquo;s data (the &ldquo;controller&rdquo; under the GDPR). For
            questions, requests about your data or to delete your account, write to{' '}
            <span className="font-semibold text-gray-900 dark:text-gray-100 select-all">{email}</span>.
          </p>
        </Section>

        <Section title="What stays on your device">
          <ul className={list}>
            <li>Scanned pages, their recognized text, document names, folders, tags, annotations and signatures.</li>
            <li>Your settings, including API keys you enter for AI features.</li>
            <li>
              They are stored in the app&rsquo;s own storage (the browser&rsquo;s IndexedDB on the web). Deleting the
              app, or the site&rsquo;s data in your browser, deletes them. The Android app is excluded from device
              backups, so a new phone starts empty unless you use sync.
            </li>
          </ul>
        </Section>

        <Section title="Text recognition">
          <ul className={list}>
            <li>
              Text is recognized on your device: by Apple Vision in the iPhone app, Google ML Kit in the Android app,
              and Tesseract in the web app and for languages the others don&rsquo;t read. Your pages are not uploaded
              for this.
            </li>
            <li>
              The first time you use a Tesseract language, its language data (a few MB) is downloaded from the
              jsDelivr CDN. jsDelivr sees your IP address, as for any download. No page content is sent.
            </li>
            <li>
              <span className="font-semibold">Android only:</span> Google ML Kit sends Google diagnostic and usage
              information: device and app information, performance metrics, error codes and a per-installation
              identifier. It contains no text or images, and the app can&rsquo;t turn it off. See{' '}
              <a className="text-blue-600 dark:text-blue-400 underline" href="https://developers.google.com/ml-kit/android-data-disclosure" target="_blank" rel="noopener noreferrer">
                Google&rsquo;s ML Kit data disclosure
              </a>
              .
            </li>
          </ul>
        </Section>

        <Section title="AI features (optional, off by default)">
          <p>
            If you set up an AI provider in Settings (OpenAI, Anthropic, Google, or another endpoint you enter), the
            text of a document, or a page image, is sent to that provider with your own API key when you use naming,
            transcription or summaries. The provider&rsquo;s own privacy policy applies to it. We don&rsquo;t receive
            it.
          </p>
          <p>
            One exception on the web: requests to Ollama Cloud pass through our server at scantab.vercel.app,
            because Ollama Cloud doesn&rsquo;t accept requests straight from a browser. The server forwards them
            without storing or logging their content or your key. The apps call every provider directly.
          </p>
        </Section>

        <Section title="Account and sync (optional)">
          <p>
            Sync between your own devices is optional and by invitation. If you use it, we process:
          </p>
          <ul className={list}>
            <li>
              <span className="font-semibold">Your email address</span>, to sign you in with a one-time code.
            </li>
            <li>
              <span className="font-semibold">Your documents, end-to-end encrypted.</span> Each record and image is
              encrypted on your device with a key only your devices hold (AES-256-GCM) before it is uploaded. We
              can&rsquo;t read them. The server sees only how many records and files there are, their sizes, and when
              they changed. Original captures never leave the device that made them.
            </li>
            <li>
              <span className="font-semibold">Your sync key, locked.</span> The key that decrypts your documents is
              stored only wrapped by your recovery key or a passkey, which we never receive. A passkey&rsquo;s
              credential ID is stored with it.
            </li>
            <li>
              <span className="font-semibold">Technical data</span> such as IP addresses in the service&rsquo;s logs,
              needed to run and protect it.
            </li>
          </ul>
          <p>
            Sync runs on Supabase (Supabase Inc.), with the database and files in its London (UK) region. The legal
            basis is providing the service you asked for (GDPR Art. 6(1)(b)).
          </p>
        </Section>

        <Section title="Website hosting">
          <p>
            The web app is hosted by Vercel Inc. Like any web server, it processes your IP address and request
            details to deliver the pages, and keeps them in short-lived logs. This is our legitimate interest in
            running a secure website (GDPR Art. 6(1)(f)). Vercel is a US company and transfers data under the EU-US
            Data Privacy Framework and standard contractual clauses.
          </p>
        </Section>

        <Section title="What we don't do">
          <ul className={list}>
            <li>No ads, no tracking across apps or websites, no analytics, and no selling or sharing of your data.</li>
            <li>
              No tracking cookies. If you sign in, the session is kept in the app&rsquo;s own storage on your device.
            </li>
          </ul>
        </Section>

        <Section title="How long data is kept, and deleting it">
          <ul className={list}>
            <li>Data on your device stays until you delete it in the app, or delete the app.</li>
            <li>
              Synced data stays while you have an account. You can remove synced documents from one device in
              Settings. To delete your account and everything stored for it, write to{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100 select-all">{email}</span>. We delete
              it within 30 days.
            </li>
          </ul>
        </Section>

        <Section title="Your rights">
          <p>
            Under the GDPR you can ask for access to your data, correction, deletion, restriction of processing, a
            copy to take elsewhere, and you can object to processing. Write to the address above. You can also
            complain to a data protection supervisory authority, in particular the one where you live.
          </p>
        </Section>

        <Section title="Children">
          <p>QuickScan is not directed at children under 13, and we don&rsquo;t knowingly process their data.</p>
        </Section>

        <Section title="Changes">
          <p>
            When this policy changes, the date at the top changes with it. Significant changes are announced in the
            app&rsquo;s release notes.
          </p>
        </Section>
      </main>
    </div>
  );
}
