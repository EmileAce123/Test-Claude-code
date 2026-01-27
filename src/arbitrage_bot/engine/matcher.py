"""
Market matching engine.

Identifies equivalent or related markets across different platforms
for potential arbitrage opportunities.
"""

import re
from datetime import datetime, timedelta
from decimal import Decimal
from difflib import SequenceMatcher
from typing import Optional

import structlog

from ..models import Market, MarketPair, MarketSource

logger = structlog.get_logger()


class MarketMatcher:
    """
    Matches markets across different prediction market platforms.

    Uses multiple heuristics including:
    - Text similarity (title matching)
    - Temporal proximity (similar resolution dates)
    - Entity extraction (people, events, organizations)
    """

    # Minimum similarity threshold for matching
    MIN_SIMILARITY_THRESHOLD = 0.6

    # Keywords to normalize/ignore in matching
    STOP_WORDS = {
        "will", "the", "be", "a", "an", "in", "on", "at", "to", "for",
        "of", "by", "with", "is", "are", "was", "were", "been", "being",
        "have", "has", "had", "do", "does", "did", "done", "?", ":", "-",
    }

    # Common variations to normalize
    NORMALIZATIONS = {
        r"\b(\d{4})\b": r" \1 ",  # Add space around years
        r"\bpresident\b": "pres",
        r"\belection\b": "elect",
        r"\bdemocrat(ic)?\b": "dem",
        r"\brepublican\b": "rep",
        r"\bwin(ning|ner)?\b": "win",
        r"\byes\b": "",
        r"\bno\b": "",
    }

    def __init__(
        self,
        similarity_threshold: float = MIN_SIMILARITY_THRESHOLD,
        max_date_difference_days: int = 30,
    ):
        self.similarity_threshold = similarity_threshold
        self.max_date_difference = timedelta(days=max_date_difference_days)
        self.logger = logger.bind(component="market_matcher")

    def find_matches(
        self,
        markets_a: list[Market],
        markets_b: list[Market],
    ) -> list[MarketPair]:
        """
        Find matching market pairs between two lists.

        Args:
            markets_a: Markets from first source
            markets_b: Markets from second source

        Returns:
            List of matched market pairs
        """
        pairs = []

        for market_a in markets_a:
            best_match: Optional[Market] = None
            best_score = 0.0

            for market_b in markets_b:
                # Skip if same source
                if market_a.source == market_b.source:
                    continue

                score = self.calculate_similarity(market_a, market_b)

                if score > best_score and score >= self.similarity_threshold:
                    best_score = score
                    best_match = market_b

            if best_match:
                pair = MarketPair(
                    market_a=market_a,
                    market_b=best_match,
                    similarity_score=best_score,
                )
                pairs.append(pair)
                self.logger.debug(
                    "Found market match",
                    market_a=market_a.title[:50],
                    market_b=best_match.title[:50],
                    score=best_score,
                )

        return pairs

    def calculate_similarity(
        self,
        market_a: Market,
        market_b: Market,
    ) -> float:
        """
        Calculate similarity score between two markets.

        Args:
            market_a: First market
            market_b: Second market

        Returns:
            Similarity score between 0 and 1
        """
        scores = []
        weights = []

        # Title similarity (highest weight)
        title_sim = self._text_similarity(market_a.title, market_b.title)
        scores.append(title_sim)
        weights.append(0.6)

        # Outcome structure similarity
        outcome_sim = self._outcome_similarity(market_a, market_b)
        scores.append(outcome_sim)
        weights.append(0.2)

        # Date proximity
        date_sim = self._date_similarity(market_a.end_date, market_b.end_date)
        scores.append(date_sim)
        weights.append(0.2)

        # Weighted average
        total_weight = sum(weights)
        weighted_score = sum(s * w for s, w in zip(scores, weights)) / total_weight

        return weighted_score

    def _text_similarity(self, text_a: str, text_b: str) -> float:
        """Calculate text similarity after normalization."""
        # Normalize texts
        norm_a = self._normalize_text(text_a)
        norm_b = self._normalize_text(text_b)

        # Use SequenceMatcher for fuzzy matching
        base_ratio = SequenceMatcher(None, norm_a, norm_b).ratio()

        # Also check word overlap (Jaccard similarity)
        words_a = set(norm_a.split())
        words_b = set(norm_b.split())

        if not words_a or not words_b:
            return base_ratio

        intersection = len(words_a & words_b)
        union = len(words_a | words_b)
        jaccard = intersection / union if union > 0 else 0

        # Combine both metrics
        return (base_ratio + jaccard) / 2

    def _normalize_text(self, text: str) -> str:
        """Normalize text for comparison."""
        # Convert to lowercase
        text = text.lower()

        # Apply normalizations
        for pattern, replacement in self.NORMALIZATIONS.items():
            text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)

        # Remove stop words
        words = text.split()
        words = [w for w in words if w not in self.STOP_WORDS]

        # Remove punctuation and extra spaces
        text = " ".join(words)
        text = re.sub(r"[^\w\s]", "", text)
        text = re.sub(r"\s+", " ", text).strip()

        return text

    def _outcome_similarity(self, market_a: Market, market_b: Market) -> float:
        """Compare outcome structures between markets."""
        # Both binary = perfect match for structure
        if market_a.is_binary and market_b.is_binary:
            return 1.0

        # Same number of outcomes is a good sign
        if len(market_a.outcomes) == len(market_b.outcomes):
            # Check if outcome names are similar
            names_a = sorted([o.name.lower() for o in market_a.outcomes])
            names_b = sorted([o.name.lower() for o in market_b.outcomes])

            matches = sum(
                1 for na, nb in zip(names_a, names_b)
                if SequenceMatcher(None, na, nb).ratio() > 0.8
            )

            return matches / len(names_a) if names_a else 0

        # Different number of outcomes
        return 0.5

    def _date_similarity(
        self,
        date_a: Optional[datetime],
        date_b: Optional[datetime],
    ) -> float:
        """Calculate similarity based on resolution dates."""
        if not date_a or not date_b:
            return 0.5  # Neutral score if dates unknown

        diff = abs((date_a - date_b).total_seconds())
        max_diff = self.max_date_difference.total_seconds()

        if diff > max_diff:
            return 0.0

        return 1.0 - (diff / max_diff)

    def extract_entities(self, text: str) -> dict[str, list[str]]:
        """
        Extract key entities from market text.

        This is a simplified implementation. In production,
        consider using spaCy or a similar NLP library.
        """
        entities: dict[str, list[str]] = {
            "persons": [],
            "organizations": [],
            "events": [],
            "dates": [],
        }

        # Extract years
        years = re.findall(r"\b(20\d{2})\b", text)
        entities["dates"].extend(years)

        # Common political figures (example - expand as needed)
        politicians = [
            "biden", "trump", "harris", "desantis", "pence",
            "obama", "clinton", "sanders", "warren", "buttigieg",
        ]
        text_lower = text.lower()
        for name in politicians:
            if name in text_lower:
                entities["persons"].append(name.title())

        # Events
        events = [
            "election", "super bowl", "world cup", "olympics",
            "oscars", "grammy", "primary", "debate",
        ]
        for event in events:
            if event in text_lower:
                entities["events"].append(event.title())

        return entities

    def suggest_matches(
        self,
        market: Market,
        candidates: list[Market],
        top_k: int = 5,
    ) -> list[tuple[Market, float]]:
        """
        Suggest best matching candidates for a given market.

        Args:
            market: The market to find matches for
            candidates: List of candidate markets
            top_k: Number of top matches to return

        Returns:
            List of (market, score) tuples, sorted by score descending
        """
        matches = []

        for candidate in candidates:
            if market.source == candidate.source:
                continue
            if market.id == candidate.id:
                continue

            score = self.calculate_similarity(market, candidate)
            matches.append((candidate, score))

        # Sort by score descending
        matches.sort(key=lambda x: x[1], reverse=True)

        return matches[:top_k]


class CrossMarketIndex:
    """
    Maintains an index of markets across platforms for efficient matching.
    """

    def __init__(self, matcher: MarketMatcher):
        self.matcher = matcher
        self.markets: dict[MarketSource, dict[str, Market]] = {}
        self.pairs: list[MarketPair] = []
        self.logger = logger.bind(component="cross_market_index")

    def add_markets(self, markets: list[Market]) -> None:
        """Add markets to the index."""
        for market in markets:
            if market.source not in self.markets:
                self.markets[market.source] = {}
            self.markets[market.source][market.id] = market

        self.logger.info(
            "Added markets to index",
            count=len(markets),
            sources=list(self.markets.keys()),
        )

    def rebuild_pairs(self) -> list[MarketPair]:
        """Rebuild all market pairs."""
        self.pairs = []
        sources = list(self.markets.keys())

        for i, source_a in enumerate(sources):
            for source_b in sources[i + 1:]:
                markets_a = list(self.markets[source_a].values())
                markets_b = list(self.markets[source_b].values())

                new_pairs = self.matcher.find_matches(markets_a, markets_b)
                self.pairs.extend(new_pairs)

        self.logger.info(f"Found {len(self.pairs)} market pairs")
        return self.pairs

    def get_pair_for_market(self, market_id: str) -> Optional[MarketPair]:
        """Find the pair containing a specific market."""
        for pair in self.pairs:
            if pair.market_a.id == market_id or pair.market_b.id == market_id:
                return pair
        return None

    def get_pairs_by_similarity(
        self,
        min_similarity: float = 0.8,
    ) -> list[MarketPair]:
        """Get pairs above a similarity threshold."""
        return [
            pair for pair in self.pairs
            if pair.similarity_score >= min_similarity
        ]
