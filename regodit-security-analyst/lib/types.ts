export type ItemStatus = 'verified' | 'conflict' | 'vague' | 'unknown' | 'confirmed' | 'not_applicable';
export type AnswerType = 'boolean' | 'text' | 'document_request';

export interface Evidence {
  doc: string;
  section?: string;
  detail: string;
  similarity?: number;
}

export interface Conflict {
  type: string;
  detail: string;
  sources: string[];
}

export interface QuestionnaireItem {
  id: string;
  question: string;
  category: string;
  priority: number;
  answer_type: AnswerType;
  status: ItemStatus;
  answer: string | null;
  evidence: Evidence[];
  conflicts: Conflict[];
  confidence: number;
  asked_user: boolean;
  last_user_note: string | null;
  updated_at: string;
}

export interface MatchedChunk {
  id: string;
  document_id: string;
  content: string;
  section_title: string | null;
  source_name: string;
  source_type: string;
  authored_at: string | null;
  similarity: number;
}