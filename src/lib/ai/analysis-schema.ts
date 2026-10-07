import { z } from 'zod';

// Configure Zod in jitless mode to prevent eval/new Function CSP violations in browser extension environments
(globalThis as any).__zod_globalConfig = {
  ...((globalThis as any).__zod_globalConfig || {}),
  jitless: true,
};
z.config({ jitless: true });

export const analysisResultSchema = z.object({
  summary: z.string().describe('A brief summary of the content'),
  category: z.string().describe('The primary category for this content'),
  suggestedFolderId: z.string().nullable().optional().describe('The ID of an exact existing folder to place this bookmark in, if an exact match exists. Must be null when creating a new hierarchy or branching into a new subfolder under an existing parent.'),
  suggestedFolderName: z.string().nullable().optional().describe('A suggested folder path. For subfolder branching under an existing parent, specify "<ExistingParent>/<NewSubfolder>". For a new hierarchy, specify "<Parent>/<Child>".'),
  isNewFolderRecommended: z.boolean().nullable().optional().describe('Whether creating a new folder or branching into a subfolder is recommended (true for new hierarchies and subfolder branches, false for exact existing folder matches)'),
  tags: z.array(z.string()).describe('An array of relevant tags for the content'),
  confidence: z.number().min(0).max(1).optional().describe('Confidence score of the analysis between 0 and 1'),
});

export type AnalysisResult = z.infer<typeof analysisResultSchema>;

// Schemas dedicated to individual AI tasks (summary/tags/folder) — used for independent calls in background auto-analysis
export const summaryResultSchema = z.object({
  summary: z.string().describe('A brief summary of the content'),
});

export const tagsResultSchema = z.object({
  tags: z.array(z.string()).describe('An array of relevant tags for the content'),
});

export const folderResultSchema = z.object({
  category: z.string().describe('The primary category for this content'),
  suggestedFolderId: z.string().nullable().optional().describe('The ID of an exact existing folder to place this bookmark in, if an exact match exists. Must be null when creating a new hierarchy or branching into a new subfolder under an existing parent.'),
  suggestedFolderName: z.string().nullable().optional().describe('A suggested folder path. For subfolder branching under an existing parent, specify "<ExistingParent>/<NewSubfolder>". For a new hierarchy, specify "<Parent>/<Child>".'),
  isNewFolderRecommended: z.boolean().nullable().optional().describe('Whether creating a new folder or branching into a subfolder is recommended (true for new hierarchies and subfolder branches, false for exact existing folder matches)'),
  tags: z.array(z.string()).describe('An array of relevant tags for the content'),
});

export type SummaryResult = z.infer<typeof summaryResultSchema>;
export type TagsResult = z.infer<typeof tagsResultSchema>;
export type FolderResult = z.infer<typeof folderResultSchema>;
