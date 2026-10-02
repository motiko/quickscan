export interface OcrLanguage {
  code: string; // Tesseract traineddata name
  label: string; // English name
  native: string; // Name in the language itself, so users can search in their own script
}

// Languages with Tesseract traineddata available to tesseract.js (historic variants omitted)
export const OCR_LANGUAGES: OcrLanguage[] = [
  { code: 'afr', label: 'Afrikaans', native: 'Afrikaans' },
  { code: 'sqi', label: 'Albanian', native: 'Shqip' },
  { code: 'amh', label: 'Amharic', native: 'አማርኛ' },
  { code: 'grc', label: 'Ancient Greek', native: 'Ἑλληνική' },
  { code: 'ara', label: 'Arabic', native: 'العربية' },
  { code: 'asm', label: 'Assamese', native: 'অসমীয়া' },
  { code: 'aze', label: 'Azerbaijani', native: 'Azərbaycanca' },
  { code: 'aze_cyrl', label: 'Azerbaijani (Cyrillic)', native: 'Азәрбајҹанҹа' },
  { code: 'eus', label: 'Basque', native: 'Euskara' },
  { code: 'bel', label: 'Belarusian', native: 'Беларуская' },
  { code: 'ben', label: 'Bengali', native: 'বাংলা' },
  { code: 'bos', label: 'Bosnian', native: 'Bosanski' },
  { code: 'bul', label: 'Bulgarian', native: 'Български' },
  { code: 'mya', label: 'Burmese', native: 'မြန်မာ' },
  { code: 'cat', label: 'Catalan', native: 'Català' },
  { code: 'ceb', label: 'Cebuano', native: 'Cebuano' },
  { code: 'khm', label: 'Central Khmer', native: 'ខ្មែរ' },
  { code: 'chr', label: 'Cherokee', native: 'ᏣᎳᎩ' },
  { code: 'chi_sim', label: 'Chinese (Simplified)', native: '简体中文' },
  { code: 'chi_tra', label: 'Chinese (Traditional)', native: '繁體中文' },
  { code: 'hrv', label: 'Croatian', native: 'Hrvatski' },
  { code: 'ces', label: 'Czech', native: 'Čeština' },
  { code: 'dan', label: 'Danish', native: 'Dansk' },
  { code: 'nld', label: 'Dutch', native: 'Nederlands' },
  { code: 'dzo', label: 'Dzongkha', native: 'རྫོང་ཁ' },
  { code: 'eng', label: 'English', native: 'English' },
  { code: 'epo', label: 'Esperanto', native: 'Esperanto' },
  { code: 'est', label: 'Estonian', native: 'Eesti' },
  { code: 'fin', label: 'Finnish', native: 'Suomi' },
  { code: 'fra', label: 'French', native: 'Français' },
  { code: 'glg', label: 'Galician', native: 'Galego' },
  { code: 'kat', label: 'Georgian', native: 'ქართული' },
  { code: 'deu', label: 'German', native: 'Deutsch' },
  { code: 'frk', label: 'German (Fraktur)', native: 'Fraktur' },
  { code: 'ell', label: 'Greek', native: 'Ελληνικά' },
  { code: 'guj', label: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'hat', label: 'Haitian Creole', native: 'Kreyòl ayisyen' },
  { code: 'heb', label: 'Hebrew', native: 'עברית' },
  { code: 'hin', label: 'Hindi', native: 'हिन्दी' },
  { code: 'hun', label: 'Hungarian', native: 'Magyar' },
  { code: 'isl', label: 'Icelandic', native: 'Íslenska' },
  { code: 'ind', label: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'iku', label: 'Inuktitut', native: 'ᐃᓄᒃᑎᑐᑦ' },
  { code: 'gle', label: 'Irish', native: 'Gaeilge' },
  { code: 'ita', label: 'Italian', native: 'Italiano' },
  { code: 'jpn', label: 'Japanese', native: '日本語' },
  { code: 'jav', label: 'Javanese', native: 'Basa Jawa' },
  { code: 'kan', label: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'kaz', label: 'Kazakh', native: 'Қазақша' },
  { code: 'kor', label: 'Korean', native: '한국어' },
  { code: 'kur', label: 'Kurdish', native: 'Kurdî' },
  { code: 'kir', label: 'Kyrgyz', native: 'Кыргызча' },
  { code: 'lao', label: 'Lao', native: 'ລາວ' },
  { code: 'lat', label: 'Latin', native: 'Latina' },
  { code: 'lav', label: 'Latvian', native: 'Latviešu' },
  { code: 'lit', label: 'Lithuanian', native: 'Lietuvių' },
  { code: 'mkd', label: 'Macedonian', native: 'Македонски' },
  { code: 'msa', label: 'Malay', native: 'Bahasa Melayu' },
  { code: 'mal', label: 'Malayalam', native: 'മലയാളം' },
  { code: 'mlt', label: 'Maltese', native: 'Malti' },
  { code: 'mar', label: 'Marathi', native: 'मराठी' },
  { code: 'nep', label: 'Nepali', native: 'नेपाली' },
  { code: 'nor', label: 'Norwegian', native: 'Norsk' },
  { code: 'ori', label: 'Oriya', native: 'ଓଡ଼ିଆ' },
  { code: 'pus', label: 'Pashto', native: 'پښتو' },
  { code: 'fas', label: 'Persian', native: 'فارسی' },
  { code: 'pol', label: 'Polish', native: 'Polski' },
  { code: 'por', label: 'Portuguese', native: 'Português' },
  { code: 'pan', label: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'ron', label: 'Romanian', native: 'Română' },
  { code: 'rus', label: 'Russian', native: 'Русский' },
  { code: 'san', label: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'srp', label: 'Serbian', native: 'Српски' },
  { code: 'srp_latn', label: 'Serbian (Latin)', native: 'Srpski' },
  { code: 'sin', label: 'Sinhala', native: 'සිංහල' },
  { code: 'slk', label: 'Slovak', native: 'Slovenčina' },
  { code: 'slv', label: 'Slovenian', native: 'Slovenščina' },
  { code: 'spa', label: 'Spanish', native: 'Español' },
  { code: 'swa', label: 'Swahili', native: 'Kiswahili' },
  { code: 'swe', label: 'Swedish', native: 'Svenska' },
  { code: 'syr', label: 'Syriac', native: 'ܣܘܪܝܝܐ' },
  { code: 'tgl', label: 'Tagalog', native: 'Tagalog' },
  { code: 'tgk', label: 'Tajik', native: 'Тоҷикӣ' },
  { code: 'tam', label: 'Tamil', native: 'தமிழ்' },
  { code: 'tel', label: 'Telugu', native: 'తెలుగు' },
  { code: 'tha', label: 'Thai', native: 'ไทย' },
  { code: 'bod', label: 'Tibetan', native: 'བོད་ཡིག' },
  { code: 'tir', label: 'Tigrinya', native: 'ትግርኛ' },
  { code: 'tur', label: 'Turkish', native: 'Türkçe' },
  { code: 'ukr', label: 'Ukrainian', native: 'Українська' },
  { code: 'urd', label: 'Urdu', native: 'اردو' },
  { code: 'uig', label: 'Uyghur', native: 'ئۇيغۇرچە' },
  { code: 'uzb', label: 'Uzbek', native: 'Oʻzbekcha' },
  { code: 'uzb_cyrl', label: 'Uzbek (Cyrillic)', native: 'Ўзбекча' },
  { code: 'vie', label: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'cym', label: 'Welsh', native: 'Cymraeg' },
  { code: 'yid', label: 'Yiddish', native: 'ייִדיש' },
];

const LANGUAGE_BY_CODE = new Map(OCR_LANGUAGES.map((l) => [l.code, l]));

export function getOcrLanguage(code: string): OcrLanguage | undefined {
  return LANGUAGE_BY_CODE.get(code);
}

/** English name of a Tesseract language code, falling back to the code itself. */
export function ocrLanguageName(code: string): string {
  return LANGUAGE_BY_CODE.get(code)?.label ?? code;
}

/** Case- and accent-insensitive form, so "espanol" finds "Español". */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Languages whose English name, native name or code contains the query. */
export function filterOcrLanguages(query: string, languages = OCR_LANGUAGES): OcrLanguage[] {
  const q = normalize(query.trim());
  if (!q) return languages;
  return languages.filter(
    (l) => normalize(l.label).includes(q) || normalize(l.native).includes(q) || l.code.includes(q)
  );
}
