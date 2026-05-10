/**
 * Durak (2 players, 36 cards). Universal module for browser and Node.
 */
(function (root) {
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i]));

  function createDeck() {
    const d = [];
    for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r, id: `${r}${s}` });
    return d;
  }

  function shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function cardKey(c) {
    return c.id;
  }

  function beats(attack, defense, trumpSuit) {
    if (!attack || !defense) return false;
    const av = RANK_VALUE[attack.rank];
    const dv = RANK_VALUE[defense.rank];
    const aTrump = attack.suit === trumpSuit;
    const dTrump = defense.suit === trumpSuit;
    if (attack.suit === defense.suit && dv > av) return true;
    if (!aTrump && dTrump) return true;
    if (aTrump && dTrump && dv > av) return true;
    return false;
  }

  function lowestTrumpInHand(hand, trumpSuit) {
    let best = null;
    for (const c of hand) {
      if (c.suit !== trumpSuit) continue;
      const v = RANK_VALUE[c.rank];
      if (best === null || v < best.v) best = { c, v };
    }
    return best ? best.c : null;
  }

  function findFirstAttacker(hands, trumpSuit) {
    let bestIdx = 0;
    let bestVal = Infinity;
    for (let i = 0; i < hands.length; i++) {
      const lt = lowestTrumpInHand(hands[i], trumpSuit);
      if (!lt) continue;
      const v = RANK_VALUE[lt.rank];
      if (v < bestVal) {
        bestVal = v;
        bestIdx = i;
      }
    }
    if (bestVal === Infinity) return 0;
    return bestIdx;
  }

  function handHasCard(hand, cardId) {
    return hand.some((c) => c.id === cardId);
  }

  function removeCards(hand, cardIds) {
    const set = new Set(cardIds);
    return hand.filter((c) => !set.has(c.id));
  }

  function getCard(hand, cardId) {
    return hand.find((c) => c.id === cardId);
  }

  function ranksOnTable(table) {
    const s = new Set();
    for (const row of table) {
      s.add(row[0].rank);
      if (row[1]) s.add(row[1].rank);
    }
    return s;
  }

  function undefendedCount(table) {
    return table.filter((r) => !r[1]).length;
  }

  function newGame(rng = Math.random) {
    const deck = shuffle(createDeck(), rng);
    const hands = [[], []];
    for (let i = 0; i < 6; i++) {
      hands[0].push(deck.pop());
      hands[1].push(deck.pop());
    }
    const trumpCard = deck.length ? deck[deck.length - 1] : null;
    const trumpSuit = trumpCard ? trumpCard.suit : '♠';
    const attacker = findFirstAttacker(hands, trumpSuit);

    return {
      deck,
      hands,
      trumpSuit,
      trumpCardId: trumpCard ? trumpCard.id : null,
      table: [],
      attackerIndex: attacker,
      defenderIndex: 1 - attacker,
      phase: 'attack',
      lastSuccessfulDefender: null,
      winnerIndex: null,
      message: '',
    };
  }

  function drawToSix(state) {
    const order = [state.attackerIndex, state.defenderIndex];
    for (const idx of order) {
      while (state.hands[idx].length < 6 && state.deck.length > 0) {
        state.hands[idx].push(state.deck.pop());
      }
    }
  }

  function checkWin(state) {
    if (state.table.length > 0) return;
    const h0 = state.hands[0].length;
    const h1 = state.hands[1].length;
    if (h0 === 0 || h1 === 0) {
      if (h0 === 0 && h1 === 0) state.winnerIndex = -1;
      else state.winnerIndex = h0 === 0 ? 0 : 1;
      state.phase = 'gameover';
    }
  }

  function afterRoundClear(state) {
    state.table = [];
    const prevDef = state.defenderIndex;
    state.attackerIndex = prevDef;
    state.defenderIndex = 1 - prevDef;
    state.phase = 'attack';
    drawToSix(state);
    checkWin(state);
  }

  function validateAttack(state, cardIds, playerIndex) {
    if (state.phase !== 'attack' && state.phase !== 'toss') return { ok: false, err: 'Falsche Phase' };
    if (playerIndex !== state.attackerIndex) return { ok: false, err: 'Nur der Angreifer' };
    const hand = state.hands[playerIndex];
    for (const id of cardIds) if (!handHasCard(hand, id)) return { ok: false, err: 'Karte nicht auf der Hand' };
    if (cardIds.length === 0) return { ok: false, err: 'Keine Karten' };

    if (state.phase === 'attack') {
      if (state.table.length !== 0) return { ok: false, err: 'Tisch nicht leer' };
      const cards = cardIds.map((id) => getCard(hand, id));
      const r0 = cards[0].rank;
      if (!cards.every((c) => c.rank === r0)) return { ok: false, err: 'Nur gleicher Rang beim ersten Angriff' };
      return { ok: true, cards };
    }

    const allowed = ranksOnTable(state.table);
    const cards = cardIds.map((id) => getCard(hand, id));
    for (const c of cards) if (!allowed.has(c.rank)) return { ok: false, err: 'Rang nicht auf dem Tisch' };
    return { ok: true, cards };
  }

  function applyAttack(state, cards) {
    const hand = state.hands[state.attackerIndex];
    const ids = cards.map((c) => c.id);
    state.hands[state.attackerIndex] = removeCards(hand, ids);
    for (const c of cards) state.table.push([c, null]);
    state.phase = 'defend';
  }

  function validateDefend(state, cardIds, playerIndex) {
    if (state.phase !== 'defend') return { ok: false, err: 'Nicht Verteidigungsphase' };
    if (playerIndex !== state.defenderIndex) return { ok: false, err: 'Nur Verteidiger' };
    const n = undefendedCount(state.table);
    if (cardIds.length !== n) return { ok: false, err: 'Anzahl Karten passt nicht' };
    const hand = state.hands[playerIndex];
    const undef = state.table.filter((r) => !r[1]).map((r) => r[0]);
    for (let i = 0; i < n; i++) {
      const d = getCard(hand, cardIds[i]);
      if (!d) return { ok: false, err: 'Karte nicht auf der Hand' };
      if (!beats(undef[i], d, state.trumpSuit)) return { ok: false, err: 'Karte schlägt nicht' };
    }
    return { ok: true, pairs: cardIds.map((id, i) => [undef[i].id, id]) };
  }

  function applyDefend(state, defenseIds) {
    const hand = state.hands[state.defenderIndex];
    let ui = 0;
    for (let i = 0; i < state.table.length; i++) {
      if (state.table[i][1]) continue;
      const defId = defenseIds[ui++];
      const defCard = getCard(hand, defId);
      state.table[i][1] = defCard;
    }
    state.hands[state.defenderIndex] = removeCards(hand, defenseIds);
    state.phase = 'toss';
  }

  function attackerPass(state, playerIndex) {
    if (state.phase !== 'toss') return { ok: false, err: 'Kein Nachlegen' };
    if (playerIndex !== state.attackerIndex) return { ok: false, err: 'Nur Angreifer' };
    afterRoundClear(state);
    return { ok: true };
  }

  function defenderTake(state, playerIndex) {
    if (state.phase !== 'defend') return { ok: false, err: 'Aufnehmen nur während Verteidigung' };
    if (undefendedCount(state.table) === 0) return { ok: false, err: 'Nichts zum Aufnehmen' };
    if (playerIndex !== state.defenderIndex) return { ok: false, err: 'Nur Verteidiger' };
    const defHand = state.hands[state.defenderIndex];
    for (const row of state.table) {
      defHand.push(row[0]);
      if (row[1]) defHand.push(row[1]);
    }
    state.table = [];
    state.phase = 'attack';
    drawToSix(state);
    checkWin(state);
    return { ok: true };
  }

  function attack(state, cardIds, playerIndex) {
    const v = validateAttack(state, cardIds, playerIndex);
    if (!v.ok) return v;
    applyAttack(state, v.cards);
    return { ok: true };
  }

  function defend(state, cardIds, playerIndex) {
    const v = validateDefend(state, cardIds, playerIndex);
    if (!v.ok) return v;
    applyDefend(state, cardIds);
    return { ok: true };
  }

  function activePlayerIndex(state) {
    if (state.winnerIndex !== null) return null;
    if (state.phase === 'attack' || state.phase === 'toss') return state.attackerIndex;
    if (state.phase === 'defend') return state.defenderIndex;
    return null;
  }

  function pickWeakestAttackCard(hand, trumpSuit) {
    if (!hand.length) return null;
    const sorted = hand.slice().sort((a, b) => {
      const at = a.suit === trumpSuit ? 1 : 0;
      const bt = b.suit === trumpSuit ? 1 : 0;
      if (at !== bt) return at - bt;
      return RANK_VALUE[a.rank] - RANK_VALUE[b.rank];
    });
    return sorted[0];
  }

  /**
   * Automatischer Zug bei Zeitüberschreitung (15s): schwächster Angriff / Nachlegen oder passen / aufnehmen.
   */
  function applyTurnTimeout(state, playerIndex) {
    if (state.winnerIndex !== null) return { ok: false, err: 'Spiel vorbei' };
    const ap = activePlayerIndex(state);
    if (ap !== playerIndex) return { ok: false, err: 'Nicht am Zug' };

    if (state.phase === 'attack' && state.attackerIndex === playerIndex) {
      const hand = state.hands[playerIndex];
      const c = pickWeakestAttackCard(hand, state.trumpSuit);
      if (!c) return { ok: false, err: 'Keine Karte' };
      return attack(state, [c.id], playerIndex);
    }

    if (state.phase === 'toss' && state.attackerIndex === playerIndex) {
      const hand = state.hands[playerIndex];
      const allowed = ranksOnTable(state.table);
      const opts = hand.filter((c) => allowed.has(c.rank));
      if (opts.length) {
        opts.sort(
          (a, b) =>
            RANK_VALUE[a.rank] - RANK_VALUE[b.rank] ||
            (a.suit === state.trumpSuit ? 1 : 0) - (b.suit === state.trumpSuit ? 1 : 0)
        );
        return attack(state, [opts[0].id], playerIndex);
      }
      return attackerPass(state, playerIndex);
    }

    if (state.phase === 'defend' && state.defenderIndex === playerIndex) {
      return defenderTake(state, playerIndex);
    }

    return { ok: false, err: 'Keine Aktion' };
  }

  function publicSnapshot(state, viewerIndex) {
    return {
      trumpSuit: state.trumpSuit,
      trumpCardId: state.trumpCardId,
      deckCount: state.deck.length,
      table: state.table.map((r) => [
        { suit: r[0].suit, rank: r[0].rank, id: r[0].id },
        r[1] ? { suit: r[1].suit, rank: r[1].rank, id: r[1].id } : null,
      ]),
      phase: state.phase,
      attackerIndex: state.attackerIndex,
      defenderIndex: state.defenderIndex,
      activePlayerIndex: activePlayerIndex(state),
      myIndex: viewerIndex,
      opponentCount: state.hands[1 - viewerIndex].length,
      myCount: state.hands[viewerIndex].length,
      myHand: state.hands[viewerIndex].map((c) => ({ suit: c.suit, rank: c.rank, id: c.id })),
      winnerIndex: state.winnerIndex,
    };
  }

  const DurakEngine = {
    SUITS,
    RANKS,
    RANK_VALUE,
    createDeck,
    shuffle,
    beats,
    newGame,
    attack,
    defend,
    attackerPass,
    defenderTake,
    publicSnapshot,
    activePlayerIndex,
    applyTurnTimeout,
    undefendedCount,
    ranksOnTable,
    drawToSix,
    checkWin,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DurakEngine;
  else root.DurakEngine = DurakEngine;
})(typeof self !== 'undefined' ? self : this);
