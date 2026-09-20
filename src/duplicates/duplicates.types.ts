export type DuplicateResolutionOutcome =
  | 'reuse_file'
  | 'same_person_new_version'
  | 'different_person'
  | 'needs_more_information'
  | 'defer';
