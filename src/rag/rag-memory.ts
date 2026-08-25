#!/usr/bin/env bun
import os from 'os'
/**
 * RAG Memory Core Library
 *
 * Core module for RAG memory operations in PAI.
 * Provides embedding generation, collection management, and memory storage/retrieval.
 *
 * Dependencies: chromadb@3.2.2, ollama@0.6.3
 */

import { ChromaClient, Collection } from "chromadb";
import { Ollama } from "ollama";
import { loadMemoryConfig, isRagEnabled } from "./memory-config";

// ============================================================================
// Configuration
// ============================================================================

export interface RAGConfig {
  chromaHost: string;
  chromaPort: number;
  ollamaHost: string;
  embedModel: string;
}

/**
 * SSOT: ~/.claude/regoc/memory-config.json + env (vidi lib/memory-config.ts).
 * Ugrađeni default je LOKALNI appliance (127.0.0.1) + `bge-m3` (CPU-realan, dobar hrvatski);
 * mrežni hostovi (.200/.4) i drugi embed model postavljaju se u memory-config.json ili envom.
 * NAPOMENA: vektori različitih modela nisu usporedivi (bge-m3=1024 dim, qwen3=4096) —
 * promjena embed modela traži re-ingest iz izvora, ne kopiranje chroma-data.
 */
const _mem = loadMemoryConfig();
export const DEFAULT_CONFIG: RAGConfig = {
  chromaHost: _mem.rag.chromaHost,
  chromaPort: _mem.rag.chromaPort,
  ollamaHost: _mem.rag.ollamaHost,
  embedModel: _mem.rag.embedModel,
};

/** Je li Tier 1 (RAG) uključen. Pozivatelji (ContextPacker) preskaču RAG kad je false. */
export function ragEnabled(): boolean {
  return isRagEnabled();
}

// ============================================================================
// Client Singletons (Connection Pooling)
// ============================================================================

let chromaClient: ChromaClient | null = null;
let ollamaClient: Ollama | null = null;

export function getChromaClient(config: RAGConfig = DEFAULT_CONFIG): ChromaClient {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      host: config.chromaHost,
      port: config.chromaPort,
    });
  }
  return chromaClient;
}

export function getOllamaClient(config: RAGConfig = DEFAULT_CONFIG): Ollama {
  if (!ollamaClient) {
    ollamaClient = new Ollama({ host: config.ollamaHost });
  }
  return ollamaClient;
}

// Reset clients (useful for testing or reconnection)
export function resetClients(): void {
  chromaClient = null;
  ollamaClient = null;
}

// ============================================================================
// Retry Utility
// ============================================================================

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries: number = 3,
  baseDelayMs: number = 100
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === retries - 1) throw error;
      await sleep(Math.pow(2, i) * baseDelayMs); // Exponential backoff
    }
  }
  throw new Error("Unreachable");
}

// ============================================================================
// Ollama Queue Lock (serialize embedding requests)
// ============================================================================
// Ollama can only process one embedding at a time
// This queue ensures requests are processed sequentially

import { existsSync, unlinkSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const LOCK_FILE = `${process.env.HOME || os.homedir()}/.tmp/ollama_embedding.lock`;
const LOCK_TIMEOUT_MS = 30000; // 30 seconds max lock hold
const LOCK_WAIT_MS = 100; // Poll interval
const MAX_WAIT_MS = 60000; // 60 seconds max wait

interface LockInfo {
  pid: number;
  timestamp: number;
}

async function acquireLock(): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < MAX_WAIT_MS) {
    // Check if lock exists
    if (existsSync(LOCK_FILE)) {
      try {
        const lockData: LockInfo = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));

        // Check if lock is stale (older than timeout)
        if (Date.now() - lockData.timestamp > LOCK_TIMEOUT_MS) {
          // Stale lock, remove it
          try { unlinkSync(LOCK_FILE); } catch {}
        } else {
          // Lock is held, wait
          await sleep(LOCK_WAIT_MS);
          continue;
        }
      } catch {
        // Corrupted lock file, remove it
        try { unlinkSync(LOCK_FILE); } catch {}
      }
    }

    // Try to acquire lock
    try {
      const lockInfo: LockInfo = { pid: process.pid, timestamp: Date.now() };
      writeFileSync(LOCK_FILE, JSON.stringify(lockInfo), { flag: "wx" }); // exclusive create
      return; // Lock acquired
    } catch {
      // Another process got the lock, wait and retry
      await sleep(LOCK_WAIT_MS);
    }
  }

  throw new Error(`Failed to acquire Ollama lock after ${MAX_WAIT_MS}ms`);
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const lockData: LockInfo = JSON.parse(readFileSync(LOCK_FILE, "utf-8"));
      // Only release if we own the lock
      if (lockData.pid === process.pid) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch {
    // Ignore errors during release
  }
}

export async function withOllamaLock<T>(fn: () => Promise<T>): Promise<T> {
  await acquireLock();
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

// ============================================================================
// Embedding Generation (with Ollama lock for serialization)
// ============================================================================

export async function generateEmbedding(
  text: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<number[]> {
  const client = getOllamaClient(config);

  // Use lock to serialize Ollama requests (Ollama handles one at a time)
  return withOllamaLock(async () => {
    return withRetry(async () => {
      const response = await client.embeddings({
        model: config.embedModel,
        prompt: text,
      });
      return response.embedding;
    });
  });
}

// ============================================================================
// Collection Management
// ============================================================================

export async function getOrCreateCollection(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<Collection> {
  const client = getChromaClient(config);
  const sanitized = sanitizeCollectionName(collectionName);

  return withRetry(async () => {
    return await client.getOrCreateCollection({ name: sanitized });
  });
}

export async function getCollection(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<Collection | null> {
  const client = getChromaClient(config);
  const sanitized = sanitizeCollectionName(collectionName);

  try {
    return await client.getCollection({ name: sanitized });
  } catch (error) {
    // Collection doesn't exist
    return null;
  }
}

export async function listCollections(
  config: RAGConfig = DEFAULT_CONFIG
): Promise<string[]> {
  const client = getChromaClient(config);

  return withRetry(async () => {
    const collections = await client.listCollections();
    return collections.map(c => c.name);
  });
}

export async function deleteCollection(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<void> {
  const client = getChromaClient(config);
  const sanitized = sanitizeCollectionName(collectionName);

  return withRetry(async () => {
    await client.deleteCollection({ name: sanitized });
  });
}

export async function getCollectionCount(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<number> {
  const client = getChromaClient(config);
  const sanitized = sanitizeCollectionName(collectionName);

  return withRetry(async () => {
    const collection = await client.getCollection({ name: sanitized });
    return await collection.count();
  });
}

export async function collectionExists(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<boolean> {
  const collections = await listCollections(config);
  return collections.includes(sanitizeCollectionName(collectionName));
}

// ============================================================================
// Memory Storage
// ============================================================================

export interface StoreMemoryOptions {
  collectionName: string;
  content: string;
  metadata: Record<string, any>;
  documentId?: string;
  config?: RAGConfig;
}

export async function storeMemory(options: StoreMemoryOptions): Promise<string> {
  const { collectionName, content, metadata, documentId, config = DEFAULT_CONFIG } = options;

  // Generate embedding
  const embedding = await generateEmbedding(content, config);

  // Get or create collection
  const collection = await getOrCreateCollection(collectionName, config);

  // Generate document ID if not provided
  const id = documentId || `doc_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  // Sanitize metadata (ChromaDB only accepts string/number/boolean)
  const cleanMetadata = sanitizeMetadata({ ...metadata, stored_at: new Date().toISOString() });

  // Add to collection
  await collection.add({
    ids: [id],
    embeddings: [embedding],
    documents: [content],
    metadatas: [cleanMetadata],
  });

  return id;
}

// ============================================================================
// Memory Retrieval & Querying
// ============================================================================

export interface MemoryResult {
  id: string;
  content: string;
  metadata: Record<string, any>;
  distance?: number;
  relevanceScore?: number;
}

export interface QueryMemoryOptions {
  collectionName: string;
  query: string;
  nResults?: number;
  where?: Record<string, any>;
  config?: RAGConfig;
}

export async function queryMemory(options: QueryMemoryOptions): Promise<MemoryResult[]> {
  const { collectionName, query, nResults = 5, where, config = DEFAULT_CONFIG } = options;

  // Check if collection exists first
  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    return [];
  }

  // Generate query embedding
  const queryEmbedding = await generateEmbedding(query, config);

  // Get collection
  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  // Query
  const results = await collection.query({
    queryEmbeddings: [queryEmbedding],
    nResults,
    where,
  });

  // Transform results
  const memories: MemoryResult[] = [];
  if (results.ids[0]) {
    for (let i = 0; i < results.ids[0].length; i++) {
      memories.push({
        id: results.ids[0][i],
        content: results.documents[0][i] as string,
        metadata: results.metadatas[0][i] as Record<string, any>,
        distance: results.distances?.[0][i],
        relevanceScore: calculateRelevanceScore(results.distances?.[0][i]),
      });
    }
  }

  return memories;
}

export interface RetrieveMemoryOptions {
  collectionName: string;
  documentId: string;
  config?: RAGConfig;
}

export async function retrieveMemory(options: RetrieveMemoryOptions): Promise<MemoryResult | null> {
  const { collectionName, documentId, config = DEFAULT_CONFIG } = options;

  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    return null;
  }

  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  const results = await collection.get({
    ids: [documentId],
  });

  if (results.ids.length === 0) {
    return null;
  }

  return {
    id: results.ids[0],
    content: results.documents[0] as string,
    metadata: results.metadatas[0] as Record<string, any>,
  };
}

// ============================================================================
// Memory Deletion
// ============================================================================

export interface DeleteMemoryOptions {
  collectionName: string;
  documentIds: string[];
  config?: RAGConfig;
}

export interface DeleteMemoryResult {
  deleted: string[];
  notFound: string[];
  errors: Array<{ id: string; error: string }>;
}

/**
 * Delete one or more documents from a collection by ID
 */
export async function deleteMemory(options: DeleteMemoryOptions): Promise<DeleteMemoryResult> {
  const { collectionName, documentIds, config = DEFAULT_CONFIG } = options;

  const result: DeleteMemoryResult = {
    deleted: [],
    notFound: [],
    errors: [],
  };

  // Check if collection exists
  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    // All IDs are "not found" if collection doesn't exist
    result.notFound = [...documentIds];
    return result;
  }

  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  // First, check which documents exist
  const existingDocs = await collection.get({ ids: documentIds });
  const existingIds = new Set(existingDocs.ids);

  // Separate found and not found
  const idsToDelete: string[] = [];
  for (const id of documentIds) {
    if (existingIds.has(id)) {
      idsToDelete.push(id);
    } else {
      result.notFound.push(id);
    }
  }

  // Delete existing documents
  if (idsToDelete.length > 0) {
    try {
      await collection.delete({ ids: idsToDelete });
      result.deleted = idsToDelete;
    } catch (error) {
      // If batch delete fails, try one by one
      for (const id of idsToDelete) {
        try {
          await collection.delete({ ids: [id] });
          result.deleted.push(id);
        } catch (err) {
          result.errors.push({
            id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  return result;
}

/**
 * Delete documents by metadata filter (where clause)
 */
export interface DeleteByFilterOptions {
  collectionName: string;
  where: Record<string, any>;
  config?: RAGConfig;
}

export async function deleteMemoryByFilter(options: DeleteByFilterOptions): Promise<DeleteMemoryResult> {
  const { collectionName, where, config = DEFAULT_CONFIG } = options;

  // First, find all matching documents
  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    return { deleted: [], notFound: [], errors: [] };
  }

  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  // Get all documents matching the filter
  const matching = await collection.get({ where });

  if (matching.ids.length === 0) {
    return { deleted: [], notFound: [], errors: [] };
  }

  // Delete them
  return deleteMemory({
    collectionName,
    documentIds: matching.ids,
    config,
  });
}

export interface GetAllMemoriesOptions {
  collectionName: string;
  where?: Record<string, any>;
  config?: RAGConfig;
}

export async function getAllMemories(options: GetAllMemoriesOptions): Promise<MemoryResult[]> {
  const { collectionName, where, config = DEFAULT_CONFIG } = options;

  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    return [];
  }

  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  const results = await collection.get({ where });

  const memories: MemoryResult[] = [];
  for (let i = 0; i < results.ids.length; i++) {
    memories.push({
      id: results.ids[i],
      content: results.documents[i] as string,
      metadata: results.metadatas[i] as Record<string, any>,
    });
  }

  return memories;
}

// ============================================================================
// BM25 Text Search Implementation
// ============================================================================

/**
 * Simple tokenizer for BM25
 * Normalizes text and splits into terms
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 2); // Skip very short tokens
}

/**
 * Calculate term frequency in a document
 */
function termFrequency(term: string, tokens: string[]): number {
  return tokens.filter(t => t === term).length;
}

/**
 * BM25 score calculation
 * k1 = 1.5, b = 0.75 are standard BM25 parameters
 */
function bm25Score(
  queryTerms: string[],
  docTokens: string[],
  avgDocLength: number,
  docCount: number,
  termDocCounts: Map<string, number>,
  k1: number = 1.5,
  b: number = 0.75
): number {
  let score = 0;
  const docLength = docTokens.length;

  for (const term of queryTerms) {
    const tf = termFrequency(term, docTokens);
    if (tf === 0) continue;

    // IDF calculation
    const docFreq = termDocCounts.get(term) || 0;
    const idf = Math.log((docCount - docFreq + 0.5) / (docFreq + 0.5) + 1);

    // BM25 term score
    const numerator = tf * (k1 + 1);
    const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
    score += idf * (numerator / denominator);
  }

  return score;
}

/**
 * Perform BM25 keyword search on a collection
 * This is a local implementation that fetches all docs and scores them
 * For large collections, consider using a dedicated search engine
 */
export async function bm25Search(
  query: string,
  collectionName: string,
  nResults: number = 10,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<MemoryResult[]> {
  const exists = await collectionExists(collectionName, config);
  if (!exists) return [];

  const client = getChromaClient(config);
  const collection = await client.getCollection({ name: sanitizeCollectionName(collectionName) });

  // Get all documents from collection
  const allDocs = await collection.get({});

  if (allDocs.ids.length === 0) return [];

  // Tokenize query
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return [];

  // Tokenize all documents and compute statistics
  const docTokensMap: Map<string, string[]> = new Map();
  let totalTokens = 0;

  for (let i = 0; i < allDocs.ids.length; i++) {
    const docText = allDocs.documents[i] as string;
    const tokens = tokenize(docText);
    docTokensMap.set(allDocs.ids[i], tokens);
    totalTokens += tokens.length;
  }

  const avgDocLength = totalTokens / allDocs.ids.length;
  const docCount = allDocs.ids.length;

  // Count documents containing each query term
  const termDocCounts: Map<string, number> = new Map();
  for (const term of queryTerms) {
    let count = 0;
    for (const tokens of docTokensMap.values()) {
      if (tokens.includes(term)) count++;
    }
    termDocCounts.set(term, count);
  }

  // Score all documents
  const scored: Array<{ id: string; score: number; index: number }> = [];
  for (let i = 0; i < allDocs.ids.length; i++) {
    const id = allDocs.ids[i];
    const tokens = docTokensMap.get(id)!;
    const score = bm25Score(queryTerms, tokens, avgDocLength, docCount, termDocCounts);

    if (score > 0) {
      scored.push({ id, score, index: i });
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top N results
  const results: MemoryResult[] = [];
  for (let i = 0; i < Math.min(nResults, scored.length); i++) {
    const { id, score, index } = scored[i];
    results.push({
      id,
      content: allDocs.documents[index] as string,
      metadata: allDocs.metadatas[index] as Record<string, any>,
      relevanceScore: score,
    });
  }

  return results;
}

// ============================================================================
// Reciprocal Rank Fusion (RRF)
// ============================================================================

/**
 * Combine multiple ranked lists using Reciprocal Rank Fusion
 * RRF score = sum(1 / (k + rank)) for each list
 * Standard k=60 provides good balance
 */
export function reciprocalRankFusion(
  lists: MemoryResult[][],
  weights: number[] = [],
  k: number = 60
): MemoryResult[] {
  const scores: Map<string, { score: number; result: MemoryResult }> = new Map();

  // Normalize weights or use equal weights
  const normalizedWeights = weights.length === lists.length
    ? weights
    : lists.map(() => 1);

  // Calculate RRF scores
  for (let listIdx = 0; listIdx < lists.length; listIdx++) {
    const list = lists[listIdx];
    const weight = normalizedWeights[listIdx];

    for (let rank = 0; rank < list.length; rank++) {
      const result = list[rank];
      const rrfScore = weight / (k + rank + 1);

      const existing = scores.get(result.id);
      if (existing) {
        existing.score += rrfScore;
        // Keep the result with higher original relevance
        if ((result.relevanceScore || 0) > (existing.result.relevanceScore || 0)) {
          existing.result = result;
        }
      } else {
        scores.set(result.id, { score: rrfScore, result });
      }
    }
  }

  // Sort by fused score and return
  const fused = Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, result }) => ({
      ...result,
      relevanceScore: score,
    }));

  return fused;
}

// ============================================================================
// Advanced Retrieval: Hybrid Search with Re-ranking
// ============================================================================

export interface HybridQueryOptions extends QueryMemoryOptions {
  recencyWeight?: number;      // 0-1, how much to boost recent memories
  workContextBoost?: number;   // Multiplier for same work_id matches
  agentTypeBoost?: number;     // Multiplier for same agent_type matches
  queryWorkId?: string;        // Current work_id for boosting
  queryAgentType?: string;     // Current agent_type for boosting
}

export interface EnhancedHybridQueryOptions extends HybridQueryOptions {
  useBM25?: boolean;           // Enable BM25 keyword matching (default: true)
  bm25Weight?: number;         // Weight for BM25 in RRF (default: 0.3)
  semanticWeight?: number;     // Weight for semantic in RRF (default: 0.7)
}

export async function hybridQueryMemory(options: HybridQueryOptions): Promise<MemoryResult[]> {
  // First, get base semantic results
  const baseResults = await queryMemory(options);

  // Apply re-ranking based on metadata
  const reranked = baseResults.map(result => {
    let score = result.relevanceScore || 0;

    // Recency boost (exponential decay with 30-day half-life)
    if (options.recencyWeight && result.metadata.stored_at) {
      const ageInDays = (Date.now() - new Date(result.metadata.stored_at).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.exp(-ageInDays / 30) * options.recencyWeight;
      score += recencyBoost;
    }

    // Work context boost
    if (options.workContextBoost && options.queryWorkId && options.queryWorkId === result.metadata.work_id) {
      score *= options.workContextBoost;
    }

    // Agent type boost
    if (options.agentTypeBoost && options.queryAgentType && options.queryAgentType === result.metadata.agent_type) {
      score *= options.agentTypeBoost;
    }

    return { ...result, relevanceScore: score };
  });

  // Sort by final score (descending)
  return reranked.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
}

/**
 * Enhanced hybrid query with BM25 + Semantic + RRF fusion
 * Combines keyword matching (BM25) with semantic similarity for better retrieval
 */
export async function enhancedHybridQuery(options: EnhancedHybridQueryOptions): Promise<MemoryResult[]> {
  const {
    useBM25 = true,
    bm25Weight = 0.3,
    semanticWeight = 0.7,
    nResults = 5,
    ...baseOptions
  } = options;

  // Get semantic results (with existing re-ranking)
  const semanticResults = await hybridQueryMemory({
    ...baseOptions,
    nResults: nResults * 2, // Fetch more for fusion
  });

  // If BM25 disabled, just return semantic results
  if (!useBM25) {
    return semanticResults.slice(0, nResults);
  }

  // Get BM25 results
  const bm25Results = await bm25Search(
    baseOptions.query,
    baseOptions.collectionName,
    nResults * 2,
    baseOptions.config
  );

  // Fuse results using RRF
  const fused = reciprocalRankFusion(
    [semanticResults, bm25Results],
    [semanticWeight, bm25Weight]
  );

  // Apply recency and context boosts to fused results
  const boosted = fused.map(result => {
    let score = result.relevanceScore || 0;

    // Recency boost
    if (options.recencyWeight && result.metadata.stored_at) {
      const ageInDays = (Date.now() - new Date(result.metadata.stored_at).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.exp(-ageInDays / 30) * options.recencyWeight;
      score += recencyBoost;
    }

    // Work context boost
    if (options.workContextBoost && options.queryWorkId && options.queryWorkId === result.metadata.work_id) {
      score *= options.workContextBoost;
    }

    // Agent type boost
    if (options.agentTypeBoost && options.queryAgentType && options.queryAgentType === result.metadata.agent_type) {
      score *= options.agentTypeBoost;
    }

    return { ...result, relevanceScore: score };
  });

  // Sort and return top N
  return boosted
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))
    .slice(0, nResults);
}

// ============================================================================
// Multi-Collection Query
// ============================================================================

export interface MultiCollectionQueryOptions {
  collections: string[];
  query: string;
  nResults?: number;
  config?: RAGConfig;
  recencyWeight?: number;
  workContextBoost?: number;
  agentTypeBoost?: number;
  queryWorkId?: string;
  queryAgentType?: string;
}

export async function queryMultipleCollections(options: MultiCollectionQueryOptions): Promise<MemoryResult[]> {
  const { collections, nResults = 5, ...queryOptions } = options;

  // Query each collection in parallel
  const results = await Promise.all(
    collections.map(collectionName =>
      hybridQueryMemory({
        ...queryOptions,
        collectionName,
        nResults: nResults * 2, // Get more results to merge
      }).catch(() => [] as MemoryResult[]) // Gracefully handle missing collections
    )
  );

  // Merge and re-sort all results
  const merged = results.flat();
  merged.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));

  // Return top N
  return merged.slice(0, nResults);
}

// ============================================================================
// Relevance Scoring Algorithm
// ============================================================================

function calculateRelevanceScore(distance: number | undefined): number {
  // Base score from cosine distance (ChromaDB uses L2 distance, convert to similarity)
  // For normalized embeddings: L2 distance ≈ sqrt(2 * (1 - cosine_similarity))
  // We approximate: similarity ≈ 1 - (distance² / 2) for small distances
  // Or simply: similarity ≈ 1 - (distance / 2) as a linear approximation
  if (distance === undefined) return 0.5;

  const cosineSimilarity = Math.max(0, 1 - (distance / 2));
  return cosineSimilarity;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Sanitize metadata for ChromaDB storage.
 * ChromaDB only accepts string, number, or boolean values.
 * Removes null, undefined, objects, and arrays.
 */
export function sanitizeMetadata(metadata: Record<string, any>): Record<string, string | number | boolean> {
  const sanitized: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(metadata)) {
    // Skip null, undefined, objects, and arrays
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue; // includes arrays

    // Only keep string, number, boolean
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export function sanitizeCollectionName(name: string): string {
  // ChromaDB collection names must:
  // - Be 3-63 characters
  // - Start and end with alphanumeric
  // - Contain only alphanumeric, underscores, or hyphens
  let sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Ensure starts with alphanumeric
  if (!/^[a-zA-Z0-9]/.test(sanitized)) {
    sanitized = "c_" + sanitized;
  }

  // Ensure ends with alphanumeric
  if (!/[a-zA-Z0-9]$/.test(sanitized)) {
    sanitized = sanitized + "_c";
  }

  // Ensure minimum length
  if (sanitized.length < 3) {
    sanitized = sanitized + "_col";
  }

  // Truncate if too long
  if (sanitized.length > 63) {
    sanitized = sanitized.substring(0, 63);
    // Ensure still ends with alphanumeric after truncation
    if (!/[a-zA-Z0-9]$/.test(sanitized)) {
      sanitized = sanitized.substring(0, 62) + "c";
    }
  }

  return sanitized;
}

export async function getCollectionStats(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<{ name: string; count: number; exists: boolean }> {
  const exists = await collectionExists(collectionName, config);
  if (!exists) {
    return { name: collectionName, count: 0, exists: false };
  }

  const count = await getCollectionCount(collectionName, config);
  return { name: collectionName, count, exists: true };
}

export async function clearCollection(
  collectionName: string,
  config: RAGConfig = DEFAULT_CONFIG
): Promise<void> {
  const exists = await collectionExists(collectionName, config);
  if (exists) {
    await deleteCollection(collectionName, config);
  }
  await getOrCreateCollection(collectionName, config);
}

// ============================================================================
// Health Check
// ============================================================================

export interface HealthCheckResult {
  chromadb: { connected: boolean; error?: string };
  ollama: { connected: boolean; error?: string };
  embedModel: { available: boolean; error?: string };
}

export async function healthCheck(config: RAGConfig = DEFAULT_CONFIG): Promise<HealthCheckResult> {
  const result: HealthCheckResult = {
    chromadb: { connected: false },
    ollama: { connected: false },
    embedModel: { available: false },
  };

  // Test ChromaDB
  try {
    const client = getChromaClient(config);
    await client.heartbeat();
    result.chromadb.connected = true;
  } catch (error) {
    result.chromadb.error = error instanceof Error ? error.message : String(error);
  }

  // Test Ollama
  try {
    const client = getOllamaClient(config);
    await client.list();
    result.ollama.connected = true;
  } catch (error) {
    result.ollama.error = error instanceof Error ? error.message : String(error);
  }

  // Test embedding model
  if (result.ollama.connected) {
    try {
      await generateEmbedding("test", config);
      result.embedModel.available = true;
    } catch (error) {
      result.embedModel.error = error instanceof Error ? error.message : String(error);
    }
  }

  return result;
}

// ============================================================================
// Exports for CLI usage
// ============================================================================

export {
  DEFAULT_CONFIG as config,
};
