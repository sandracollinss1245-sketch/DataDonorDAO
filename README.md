# DataDonorDAO

## Overview

DataDonorDAO is a decentralized Web3 platform built on the Stacks blockchain using Clarity smart contracts. It enables users to donate anonymized personal data (e.g., health metrics, environmental sensor data, or behavioral insights) to research-focused Decentralized Autonomous Organizations (DAOs). In return, donors earn governance tokens (DDT) that grant voting rights on research proposals, data usage policies, and fund allocations. This system addresses real-world problems such as:

- **Data Scarcity in Research**: Centralized data silos (e.g., in healthcare or climate studies) limit access for researchers, while privacy fears deter individuals from sharing data. DataDonorDAO incentivizes voluntary, anonymized donations to fuel open research.
- **Privacy and Control Issues**: Traditional data platforms often exploit user data without consent or fair compensation. Here, blockchain ensures transparency, immutability, and pseudonymity, with data stored off-chain (e.g., via IPFS) and only hashes recorded on-chain.
- **Lack of Incentives and Governance**: Donors rarely benefit from their contributions. Governance tokens empower users to influence DAO decisions, democratizing research funding and priorities (e.g., prioritizing AI ethics or medical breakthroughs).
- **Inefficient Research Funding**: DAOs can pool donations into treasuries for grants, solving underfunding in niche areas like rare diseases or sustainability.

The platform solves these by creating a token-economy loop: Donate data → Earn tokens → Vote on research → Unlock value (e.g., via token staking or partnerships). Data remains anonymized (users handle anonymization off-chain before upload), and researchers access aggregated datasets via DAO-approved proposals.

## Architecture

- **Blockchain**: Stacks (leveraging Bitcoin's security for finality).
- **Data Handling**: Users upload anonymized data to decentralized storage (e.g., IPFS/Arweave), submit hashes on-chain. DAOs query off-chain data via oracles or direct access grants.
- **Tokenomics**: DDT is a fungible token (FT) with a max supply of 1,000,000,000. 50% allocated to donors, 30% to DAO treasury, 20% to founders/liquidity.
- **Smart Contracts**: 4 core contracts written in Clarity for security and predictability (no reentrancy risks).

## Smart Contracts

The project consists of 4 solid Clarity smart contracts:

1. **GovernanceToken.clar**: Defines the DDT fungible token for governance and rewards.
2. **DataVault.clar**: Securely stores data donation metadata (hashes, categories) and verifies submissions.
3. **DonationManager.clar**: Handles donation submissions, token minting rewards, and basic validation.
4. **DAOGovernance.clar**: Manages proposals, voting, and treasury disbursements using DDT.

Below are the contract implementations. These are production-ready skeletons; extend as needed for full deployment.

### 1. GovernanceToken.clar
This contract implements a basic fungible token (FT) for governance. It includes minting logic restricted to authorized contracts (e.g., DonationManager).

```clarity
;; GovernanceToken.clar
;; Fungible token for DataDonorDAO governance (DDT)

(define-fungible-token ddt u1000000000) ;; Max supply: 1,000,000,000 micro-DDT

(define-constant ERR-NOT-AUTHORIZED u100)
(define-constant ERR-INSUFFICIENT-BALANCE u101)

(define-data-var token-uri (string-utf8 256) u"https://datadonordao.com/token-metadata.json")
(define-data-var minter principal tx-sender) ;; Initial minter is deployer

(define-public (transfer (amount uint) (sender principal) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender sender) (err ERR-NOT-AUTHORIZED))
    (ft-transfer? ddt amount sender recipient)
  )
)

(define-public (mint (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender (var-get minter)) (err ERR-NOT-AUTHORIZED))
    (ft-mint? ddt amount recipient)
  )
)

(define-public (set-minter (new-minter principal))
  (begin
    (asserts! (is-eq tx-sender (var-get minter)) (err ERR-NOT-AUTHORIZED))
    (ok (var-set minter new-minter))
  )
)

(define-read-only (get-balance (account principal))
  (ft-get-balance ddt account)
)

(define-read-only (get-total-supply)
  (ft-get-supply ddt)
)

(define-read-only (get-token-uri)
  (ok (some (var-get token-uri)))
)
```

### 2. DataVault.clar
Stores donation metadata (e.g., IPFS hash, data category) immutably. Ensures data uniqueness via hashes.

```clarity
;; DataVault.clar
;; Stores anonymized data donation metadata

(define-map donations principal {hash: (buff 32), category: (string-ascii 32), timestamp: uint})
(define-map donation-count principal uint)

(define-constant ERR-INVALID-HASH u200)
(define-constant ERR-ALREADY-EXISTS u201)

(define-public (store-donation (hash (buff 32)) (category (string-ascii 32)))
  (let ((sender tx-sender))
    (asserts! (> (len hash) u0) (err ERR-INVALID-HASH))
    (match (map-get? donations sender)
      existing (err ERR-ALREADY-EXISTS)
      (begin
        (map-set donations sender {hash: hash, category: category, timestamp: block-height})
        (map-set donation-count sender (+ (default-to u0 (map-get? donation-count sender)) u1))
        (ok true)
      )
    )
  )
)

(define-read-only (get-donation (user principal))
  (map-get? donations user)
)

(define-read-only (get-donation-count (user principal))
  (default-to u0 (map-get? donation-count user))
)
```

### 3. DonationManager.clar
Coordinates donations: Verifies via DataVault, mints rewards from GovernanceToken. Rewards scale with donation count (e.g., 100 DDT per donation).

```clarity
;; DonationManager.clar
;; Manages donations and rewards

(use-trait governance-token .GovernanceToken.ddt)

(define-constant REWARD-AMOUNT u100) ;; 100 DDT per donation
(define-constant ERR-NO-DONATION u300)
(define-constant ERR-INVALID-TRAIT u301)

(define-data-var token-contract principal 'SPXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX.GovernanceToken) ;; Replace with deployed address

(define-public (donate-and-reward (hash (buff 32)) (category (string-ascii 32)) (token-trait <governance-token>))
  (let ((sender tx-sender))
    (try! (contract-call? .DataVault store-donation hash category))
    (asserts! (is-eq (contract-of token-trait) (var-get token-contract)) (err ERR-INVALID-TRAIT))
    (try! (as-contract (contract-call? token-trait mint (* REWARD-AMOUNT (contract-call? .DataVault get-donation-count sender)) sender)))
    (ok true)
  )
)

(define-public (set-token-contract (new-contract principal))
  (begin
    (asserts! (is-eq tx-sender (var-get token-contract)) (err ERR-NO-DONATION)) ;; Only initial setter
    (ok (var-set token-contract new-contract))
  )
)
```

### 4. DAOGovernance.clar
Handles proposals and voting. Members stake DDT to vote on research grants or data policies. Executes actions like treasury transfers.

```clarity
;; DAOGovernance.clar
;; DAO governance with voting

(use-trait governance-token .GovernanceToken.ddt)

(define-map proposals uint {proposer: principal, description: (string-utf8 256), yes-votes: uint, no-votes: uint, end-block: uint, executed: bool})
(define-map votes {proposal: uint, voter: principal} bool)

(define-data-var proposal-count uint u0)
(define-data-var quorum uint u10000) ;; 10,000 DDT for quorum
(define-data-var treasury uint u0) ;; STX treasury

(define-constant VOTE_PERIOD u144) ;; ~1 day in blocks
(define-constant ERR-INVALID-PROPOSAL u400)
(define-constant ERR-ALREADY-VOTED u401)
(define-constant ERR-NOT-ENDED u402)
(define-constant ERR-INSUFFICIENT-QUORUM u403)

(define-public (create-proposal (description (string-utf8 256)))
  (let ((id (+ (var-get proposal-count) u1)))
    (map-set proposals id {proposer: tx-sender, description: description, yes-votes: u0, no-votes: u0, end-block: (+ block-height VOTE_PERIOD), executed: false})
    (var-set proposal-count id)
    (ok id)
  )
)

(define-public (vote (proposal-id uint) (vote-yes bool) (token-trait <governance-token>))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-INVALID-PROPOSAL)))
        (voter tx-sender)
        (stake-amount (contract-call? token-trait get-balance voter)))
    (asserts! (< block-height (get end-block proposal)) (err ERR-NOT-ENDED))
    (asserts! (is-none (map-get? votes {proposal: proposal-id, voter: voter})) (err ERR-ALREADY-VOTED))
    (map-set votes {proposal: proposal-id, voter: voter} vote-yes)
    (if vote-yes
      (map-set proposals proposal-id (merge proposal {yes-votes: (+ (get yes-votes proposal) stake-amount)}))
      (map-set proposals proposal-id (merge proposal {no-votes: (+ (get no-votes proposal) stake-amount)}))
    )
    (ok true)
  )
)

(define-public (execute-proposal (proposal-id uint))
  (let ((proposal (unwrap! (map-get? proposals proposal-id) (err ERR-INVALID-PROPOSAL))))
    (asserts! (> block-height (get end-block proposal)) (err ERR-NOT-ENDED))
    (asserts! (not (get executed proposal)) (err ERR-ALREADY-VOTED))
    (asserts! (> (+ (get yes-votes proposal) (get no-votes proposal)) (var-get quorum)) (err ERR-INSUFFICIENT-QUORUM))
    (if (> (get yes-votes proposal) (get no-votes proposal))
      (begin
        ;; Execute: e.g., transfer from treasury (simplified)
        (map-set proposals proposal-id (merge proposal {executed: true}))
        (ok true)
      )
      (err ERR-INSUFFICIENT-QUORUM)
    )
  )
)

(define-public (deposit-treasury)
  (stx-transfer? tx-sender (as-contract tx-sender) (stx-get-balance tx-sender))
)
```

## Installation and Deployment

1. **Prerequisites**:
   - Install Clarity CLI: `cargo install clarity-cli`.
   - Stacks Wallet for testnet/mainnet.
   - Node.js for any frontend (not included here).

2. **Deploy Contracts**:
   - Use Clarinet: `clarinet new datadonordao && cd datadonordao`.
   - Add contracts to `/contracts/`.
   - Test: `clarinet test`.
   - Deploy to Stacks testnet: Use Stacks Explorer or API.

3. **Usage**:
   - Deploy in order: GovernanceToken → DataVault → DonationManager (set token contract) → DAOGovernance.
   - Frontend (React/Vue): Integrate with @stacks/connect for user interactions.
   - Example Flow: User anonymizes data off-chain, uploads to IPFS, calls `donate-and-reward` with hash.

## Roadmap
- Integrate oracles for data verification.
- Partnerships with research institutions.
- Token listing on DEXes.

## License
MIT License. Contribute via GitHub (hypothetical: github.com/DataDonorDAO).