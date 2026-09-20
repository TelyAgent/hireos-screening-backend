import { Injectable } from '@nestjs/common';

type Segment = { id: string; text: string; page?: number };

export type Evidence = {
  sourceMaterialId: string;
  segmentId: string;
  quote: string;
};

export type ParsedProfile = {
  displayName: string;
  email: string | null;
  phone: string | null;
  location: { value: string; status: 'known' | 'unknown'; evidence?: Evidence } | null;
  workAuthorization: { value: string; status: 'known' | 'unknown'; evidence?: Evidence } | null;
  skills: Array<{ name: string; evidence: Evidence }>;
  languages: Array<{ name: string; evidence: Evidence }>;
  employmentHistory: [];
  education: [];
  certifications: [];
  projects: [];
  compensationExpectation: null;
  missingFields: string[];
  sourceEntries: Evidence[];
};

const SKILLS = [
  'TypeScript', 'JavaScript', 'Python', 'Java', 'Go', 'C#', 'Ruby', 'PHP',
  'React', 'Next.js', 'Node.js', 'NestJS', 'Express', 'Vue', 'Angular',
  'PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Kafka', 'Docker', 'Kubernetes',
  'AWS', 'Azure', 'GCP', 'Terraform', 'Git', 'GraphQL', 'REST',
];

const LANGUAGES = ['English', 'Chinese', 'Mandarin', 'Spanish', 'French', 'German', 'Japanese', 'Korean'];

@Injectable()
export class ProfileParserService {
  parse(materialId: string, segments: Segment[], fallbackName: string): ParsedProfile {
    const entries = segments.flatMap((segment) =>
      segment.text.split(/\r?\n/).map((line) => ({
        line: line.trim(),
        evidence: { sourceMaterialId: materialId, segmentId: segment.id, quote: line.trim().slice(0, 500) },
      })).filter((item) => item.line.length > 0),
    );
    const text = entries.map((item) => item.line).join('\n');
    const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    const phoneMatch = text.match(/(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3}[\s.-]\d{4}\b/);
    const emailEvidence = emailMatch ? evidenceFor(entries, emailMatch[0]) : undefined;
    const phoneEvidence = phoneMatch ? evidenceFor(entries, phoneMatch[0]) : undefined;
    const skills = uniqueMatches(SKILLS, entries);
    const languages = uniqueMatches(LANGUAGES, entries);
    const locationEntry = entries.find(({ line }) => /\b(location|based in|address|city|居住地|所在地)\b/i.test(line));
    const authorizationEntry = entries.find(({ line }) => /\b(authorized to work|work authorization|visa|sponsorship|citizen|permanent resident)\b/i.test(line));
    const location = locationEntry
      ? { value: cleanLabeledValue(locationEntry.line), status: 'known' as const, evidence: locationEntry.evidence }
      : null;
    const workAuthorization = authorizationEntry
      ? { value: authorizationEntry.line.slice(0, 200), status: 'known' as const, evidence: authorizationEntry.evidence }
      : null;

    return {
      displayName: inferDisplayName(entries, fallbackName),
      email: emailMatch?.[0] || null,
      phone: phoneMatch?.[0] || null,
      location,
      workAuthorization,
      skills,
      languages,
      employmentHistory: [],
      education: [],
      certifications: [],
      projects: [],
      compensationExpectation: null,
      missingFields: [
        ...(location ? [] : ['location']),
        ...(workAuthorization ? [] : ['work_authorization']),
        'employment_history',
        'education',
        'compensation_expectation',
      ],
      sourceEntries: [
        ...(emailEvidence ? [emailEvidence] : []),
        ...(phoneEvidence ? [phoneEvidence] : []),
        ...(location?.evidence ? [location.evidence] : []),
        ...(workAuthorization?.evidence ? [workAuthorization.evidence] : []),
        ...skills.map((skill) => skill.evidence),
        ...languages.map((language) => language.evidence),
      ],
    };
  }
}

function uniqueMatches(
  vocabulary: string[],
  entries: Array<{ line: string; evidence: Evidence }>,
) {
  const found = new Map<string, Evidence>();
  for (const item of entries) {
    for (const term of vocabulary) {
      if (new RegExp(`(^|[^a-z0-9+#.-])${escapeRegExp(term)}([^a-z0-9+#.-]|$)`, 'i').test(item.line) && !found.has(term)) {
        found.set(term, item.evidence);
      }
    }
  }
  return Array.from(found, ([name, evidence]) => ({ name, evidence }));
}

function evidenceFor(entries: Array<{ line: string; evidence: Evidence }>, value: string) {
  return entries.find(({ line }) => line.toLowerCase().includes(value.toLowerCase()))?.evidence;
}

function inferDisplayName(entries: Array<{ line: string; evidence: Evidence }>, fallback: string) {
  const first = entries.find(({ line }) => {
    if (line.length < 2 || line.length > 80) return false;
    if (line.includes('@') || /\d{4,}/.test(line)) return false;
    return !/resume|curriculum vitae|profile|summary|experience|skills|education/i.test(line);
  })?.line;
  return first || fallback;
}

function cleanLabeledValue(line: string) {
  return line.replace(/^(location|based in|address|city|居住地|所在地)\s*[:：-]?\s*/i, '').trim().slice(0, 200);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
