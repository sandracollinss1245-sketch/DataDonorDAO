;; DAOGovernance.clar
;; Governance contract for DataDonorDAO
;; Features: Proposal creation, voting with staked tokens, treasury management (STX and FT),
;; staking/unstaking with lockup, quorum/threshold config, emergency pause, events.

(use-trait governance-token .GovernanceToken.ddt)

(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-PROPOSAL-NOT-FOUND u101)
(define-constant ERR-VOTING-ENDED u102)
(define-constant ERR-VOTING-NOT-ENDED u103)
(define-constant ERR-ALREADY-VOTED u104)
(define-constant ERR-INSUFFICIENT-QUORUM u105)
(define-constant ERR-INSUFFICIENT-THRESHOLD u106)
(define-constant ERR-PAUSED u107)
(define-constant ERR-INVALID-AMOUNT u108)
(define-constant ERR-INVALID-PROPOSAL-TYPE u109)
(define-constant ERR-LOCKUP-NOT-EXPIRED u110)
(define-constant ERR-NO-STAKE u111)
(define-constant ERR-EXECUTION-FAILED u112)
(define-constant ERR-INVALID-STRING u113)
(define-constant ERR-INVALID-PRINCIPAL u114)

(define-constant PROPOSAL-TYPE-FUND-RELEASE u1)
(define-constant PROPOSAL-TYPE-POLICY-CHANGE u2)
(define-constant PROPOSAL-TYPE-TOKEN-MINT u3)

(define-constant VOTE_PERIOD u1440) ;; ~10 days
(define-constant LOCKUP_PERIOD u144) ;; ~1 day
(define-constant MIN_QUORUM u10) ;; 10% of total staked
(define-constant MIN_THRESHOLD u51) ;; 51% yes votes
(define-constant MAX_STRING_LEN u256)

(define-data-var admin principal tx-sender)
(define-data-var paused bool false)
(define-data-var quorum-percent uint MIN_QUORUM)
(define-data-var threshold-percent uint MIN_THRESHOLD)
(define-data-var proposal-count uint u0)
(define-data-var treasury-stx uint u0)
(define-data-var treasury-ft uint u0)

(define-map proposals uint 
  {
    proposer: principal,
    description: (string-utf8 256),
    proposal-type: uint,
    param1: uint,
    param2: principal,
    param3: (string-utf8 100),
    yes-votes: uint,
    no-votes: uint,
    start-block: uint,
    end-block: uint,
    executed: bool
  }
)

(define-map votes {proposal: uint, voter: principal} {voted: bool, amount: uint})
(define-map stakes principal {amount: uint, lockup-end: uint})
(define-map events uint {timestamp: uint, event-type: (string-ascii 32), data: (string-utf8 256)})
(define-data-var event-count uint u0)

;; Private functions
(define-private (emit-event (event-type (string-ascii 32)) (data (string-utf8 256)))
  (let ((id (+ (var-get event-count) u1)))
    (map-set events id {timestamp: block-height, event-type: event-type, data: data})
    (var-set event-count id)
    (print {event: event-type, data: data})
    id
  )
)

(define-private (calculate-quorum (total-staked uint))
  (/ (* total-staked (var-get quorum-percent)) u100)
)

(define-private (calculate-threshold (total-votes uint))
  (/ (* total-votes (var-get threshold-percent)) u100)
)

(define-private (get-total-staked (token-trait <governance-token>))
  (fold + (map get-stake-amount (contract-call? token-trait get-all-holders)) u0)
)

(define-private (get-stake-amount (holder principal))
  (default-to u0 (get amount (map-get? stakes holder)))
)

(define-private (validate-string (input (string-utf8 256)))
  (if (<= (len input) MAX_STRING_LEN)
    (ok true)
    (err ERR-INVALID-STRING)
  )
)

(define-private (validate-principal (input principal))
  (ok true) ;; Clarity ensures principal validity
)

;; Public functions
(define-public (set-admin (new-admin principal))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (try! (validate-principal new-admin))
    (var-set admin new-admin)
    (emit-event "admin-change" (concat "New admin: " (principal-to-string new-admin)))
    (ok true)
  )
)

(define-public (pause)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (var-set paused true)
    (emit-event "pause" "DAO paused")
    (ok true)
  )
)

(define-public (unpause)
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (var-set paused false)
    (emit-event "unpause" "DAO unpaused")
    (ok true)
  )
)

(define-public (set-quorum-percent (new-percent uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (asserts! (and (>= new-percent u1) (<= new-percent u100)) (err ERR-INVALID-AMOUNT))
    (var-set quorum-percent new-percent)
    (emit-event "param-change" (concat "Quorum set to " (uint-to-string new-percent)))
    (ok true)
  )
)

(define-public (set-threshold-percent (new-percent uint))
  (begin
    (asserts! (is-eq tx-sender (var-get admin)) (err ERR-NOT-AUTHORIZED))
    (asserts! (and (>= new-percent u50) (<= new-percent u100)) (err ERR-INVALID-AMOUNT))
    (var-set threshold-percent new-percent)
    (emit-event "param-change" (concat "Threshold set to " (uint-to-string new-percent)))
    (ok true)
  )
)

(define-public (stake (amount uint) (token-trait <governance-token>))
  (let ((sender tx-sender)
        (current-stake (default-to {amount: u0, lockup-end: u0} (map-get? stakes sender))))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (try! (contract-call? token-trait transfer amount sender (as-contract tx-sender)))
    (map-set stakes sender {amount: (+ (get amount current-stake) amount), lockup-end: (+ block-height LOCKUP_PERIOD)})
    (emit-event "stake" (concat (principal-to-string sender) " staked " (uint-to-string amount)))
    (ok true)
  )
)

(define-public (unstake (amount uint) (token-trait <governance-token>))
  (let ((sender tx-sender)
        (current-stake (unwrap! (map-get? stakes sender) (err ERR-NO-STAKE))))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (<= amount (get amount current-stake)) (err ERR-INVALID-AMOUNT))
    (asserts! (>= block-height (get lockup-end current-stake)) (err ERR-LOCKUP-NOT-EXPIRED))
    (try! (as-contract (contract-call? token-trait transfer amount tx-sender sender)))
    (if (is-eq amount (get amount current-stake))
      (map-delete stakes sender)
      (map-set stakes sender {amount: (- (get amount current-stake) amount), lockup-end: (get lockup-end current-stake)})
    )
    (emit-event "unstake" (concat (principal-to-string sender) " unstaked " (uint-to-string amount)))
    (ok true)
  )
)

(define-public (create-proposal (description (string-utf8 256)) (proposal-type uint) (param1 uint) (param2 principal) (param3 (string-utf8 100)))
  (let ((id (+ (var-get proposal-count) u1))
        (sender tx-sender))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (or (is-eq proposal-type PROPOSAL-TYPE-FUND-RELEASE) 
                  (is-eq proposal-type PROPOSAL-TYPE-POLICY-CHANGE) 
                  (is-eq proposal-type PROPOSAL-TYPE-TOKEN-MINT)) 
              (err ERR-INVALID-PROPOSAL-TYPE))
    (asserts! (> (get amount (default-to {amount: u0, lockup-end: u0} (map-get? stakes sender))) u0) 
              (err ERR-NO-STAKE))
    (try! (validate-string description))
    (try! (validate-string param3))
    (try! (validate-principal param2))
    (map-set proposals id 
      {
        proposer: sender,
        description: description,
        proposal-type: proposal-type,
        param1: param1,
        param2: param2,
        param3: param3,
        yes-votes: u0,
        no-votes: u0,
        start-block: block-height,
        end-block: (+ block-height VOTE_PERIOD),
        executed: false
      }
    )
    (var-set proposal-count id)
    (emit-event "proposal-created" (concat "ID: " (uint-to-string id) " Type: " (uint-to-string proposal-type)))
    (ok id)
  )
)

(define-public (vote (proposal-id uint) (vote-yes bool) (token-trait <governance-token>))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (sender tx-sender)
        (stake (unwrap! (map-get? stakes sender) (err ERR-NO-STAKE)))
        (existing-vote (map-get? votes {proposal: proposal-id, voter: sender})))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (< block-height (get end-block proposal)) (err ERR-VOTING-ENDED))
    (asserts! (is-none existing-vote) (err ERR-ALREADY-VOTED))
    (map-set votes {proposal: proposal-id, voter: sender} {voted: vote-yes, amount: (get amount stake)})
    (if vote-yes
      (map-set proposals proposal-id (merge proposal {yes-votes: (+ (get yes-votes proposal) (get amount stake))}))
      (map-set proposals proposal-id (merge proposal {no-votes: (+ (get no-votes proposal) (get amount stake))}))
    )
    (emit-event "vote-cast" (concat "Proposal " (uint-to-string proposal-id) " Voter: " (principal-to-string sender) " Yes: " (bool-to-string vote-yes)))
    (ok true)
  )
)

(define-public (execute-proposal (proposal-id uint) (token-trait <governance-token>))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-PROPOSAL-NOT-FOUND)))
        (total-votes (+ (get yes-votes proposal) (get no-votes proposal)))
        (total-staked (get-total-staked token-trait))
        (quorum (calculate-quorum total-staked))
        (threshold (calculate-threshold total-votes)))
    (asserts! (not (var-get paused)) (err ERR-PAUSED))
    (asserts! (> block-height (get end-block proposal)) (err ERR-VOTING-NOT-ENDED))
    (asserts! (not (get executed proposal)) (err ERR-ALREADY-VOTED))
    (asserts! (>= total-votes quorum) (err ERR-INSUFFICIENT-QUORUM))
    (asserts! (> (get yes-votes proposal) threshold) (err ERR-INSUFFICIENT-THRESHOLD))
    (map-set proposals proposal-id (merge proposal {executed: true}))
    (match (get proposal-type proposal)
      PROPOSAL-TYPE-FUND-RELEASE (try! (execute-fund-release proposal))
      PROPOSAL-TYPE-POLICY-CHANGE (try! (execute-policy-change proposal))
      PROPOSAL-TYPE-TOKEN-MINT (try! (execute-token-mint proposal token-trait))
      (err ERR-INVALID-PROPOSAL-TYPE)
    )
    (emit-event "proposal-executed" (concat "ID: " (uint-to-string proposal-id)))
    (ok true)
  )
)

(define-private (execute-fund-release (proposal {proposer: principal, description: (string-utf8 256), proposal-type: uint, param1: uint, param2: principal, param3: (string-utf8 100), yes-votes: uint, no-votes: uint, start-block: uint, end-block: uint, executed: bool}))
  (let ((amount (get param1 proposal))
        (recipient (get param2 proposal)))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (asserts! (>= (var-get treasury-stx) amount) (err ERR-INVALID-AMOUNT))
    (var-set treasury-stx (- (var-get treasury-stx) amount))
    (try! (as-contract (stx-transfer? amount tx-sender recipient)))
    (ok true)
  )
)

(define-private (execute-policy-change (proposal {proposer: principal, description: (string-utf8 256), proposal-type: uint, param1: uint, param2: principal, param3: (string-utf8 100), yes-votes: uint, no-votes: uint, start-block: uint, end-block: uint, executed: bool}))
  (let ((key (get param3 proposal))
        (value (get param1 proposal)))
    (if (is-eq key u"quorum")
      (begin
        (asserts! (and (>= value u1) (<= value u100)) (err ERR-INVALID-AMOUNT))
        (var-set quorum-percent value)
        (ok true)
      )
      (if (is-eq key u"threshold")
        (begin
          (asserts! (and (>= value u50) (<= value u100)) (err ERR-INVALID-AMOUNT))
          (var-set threshold-percent value)
          (ok true)
        )
        (err ERR-INVALID-PROPOSAL-TYPE)
      )
    )
  )
)

(define-private (execute-token-mint (proposal {proposer: principal, description: (string-utf8 256), proposal-type: uint, param1: uint, param2: principal, param3: (string-utf8 100), yes-votes: uint, no-votes: uint, start-block: uint, end-block: uint, executed: bool}) (token-trait <governance-token>))
  (let ((amount (get param1 proposal))
        (recipient (get param2 proposal)))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (try! (as-contract (contract-call? token-trait mint amount recipient)))
    (ok true)
  )
)

(define-public (deposit-treasury-stx)
  (let ((amount (stx-get-balance tx-sender)))
    (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
    (try! (stx-transfer? amount tx-sender (as-contract tx-sender)))
    (var-set treasury-stx (+ (var-get treasury-stx) amount))
    (emit-event "deposit" (concat "STX deposited: " (uint-to-string amount)))
    (ok amount)
  )
)

(define-public (deposit-treasury-ft (amount uint) (token-trait <governance-token>))
  (asserts! (> amount u0) (err ERR-INVALID-AMOUNT))
  (try! (contract-call? token-trait transfer amount tx-sender (as-contract tx-sender)))
  (var-set treasury-ft (+ (var-get treasury-ft) amount))
  (emit-event "deposit" (concat "FT deposited: " (uint-to-string amount)))
  (ok amount)
)

;; Read-only functions
(define-read-only (get-proposal (id uint))
  (map-get? proposals id)
)

(define-read-only (get-stake (user principal))
  (map-get? stakes user)
)

(define-read-only (get-vote (proposal-id uint) (voter principal))
  (map-get? votes {proposal: proposal-id, voter: voter})
)

(define-read-only (get-event (id uint))
  (map-get? events id)
)

(define-read-only (get-treasury-balance)
  {stx: (var-get treasury-stx), ft: (var-get treasury-ft)}
)

(define-read-only (get-config)
  {quorum-percent: (var-get quorum-percent), threshold-percent: (var-get threshold-percent), paused: (var-get paused)}
)

;; Helper functions
(define-private (uint-to-string (value uint))
  (unwrap-panic (int-to-utf8 (to-int value)))
)

(define-private (bool-to-string (value bool))
  (if value u"true" u"false")
)

(define-private (principal-to-string (p principal))
  (unwrap-panic (principal-destruct? p))
)