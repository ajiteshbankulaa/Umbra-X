/** Small, deterministic sparse-vector index for the bundled research corpus. */
export class PassageVectorIndex {
  private readonly inverseFrequency = new Map<string, number>()
  private readonly vectors: Map<string, number>[]

  constructor(documents: string[]) {
    const tokens = documents.map(text => this.tokens(text))
    for (const document of tokens) {
      for (const term of new Set(document)) {
        this.inverseFrequency.set(term, (this.inverseFrequency.get(term) ?? 0) + 1)
      }
    }
    for (const [term, frequency] of this.inverseFrequency) {
      this.inverseFrequency.set(term, 1 + Math.log((1 + documents.length) / (1 + frequency)))
    }
    this.vectors = tokens.map(terms => this.vector(terms))
  }

  scores(query: string) {
    const queryVector = this.vector(this.tokens(query))
    return this.vectors.map(document => {
      let similarity = 0
      for (const [term, weight] of queryVector) similarity += weight * (document.get(term) ?? 0)
      return similarity
    })
  }

  private tokens(text: string) {
    return text.toLowerCase().match(/[a-z0-9]+/g)?.filter(word => word.length > 2) ?? []
  }

  private vector(tokens: string[]) {
    const weights = new Map<string, number>()
    for (const term of tokens) {
      const idf = this.inverseFrequency.get(term)
      if (idf !== undefined) weights.set(term, (weights.get(term) ?? 0) + idf)
    }
    const norm = Math.hypot(...weights.values())
    if (norm) for (const [term, weight] of weights) weights.set(term, weight / norm)
    return weights
  }
}
