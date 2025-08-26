import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface Proposal {
  proposer: string;
  description: string;
  proposalType: number;
  param1: number;
  param2: string;
  param3: string;
  yesVotes: number;
  noVotes: number;
  startBlock: number;
  endBlock: number;
  executed: boolean;
}

interface Vote {
  voted: boolean;
  amount: number;
}

interface Stake {
  amount: number;
  lockupEnd: number;
}

interface Event {
  timestamp: number;
  eventType: string;
  data: string;
}

interface TreasuryBalance {
  stx: number;
  ft: number;
}

interface Config {
  quorumPercent: number;
  thresholdPercent: number;
  paused: boolean;
}

interface ContractState {
  admin: string;
  paused: boolean;
  quorumPercent: number;
  thresholdPercent: number;
  proposalCount: number;
  treasuryStx: number;
  treasuryFt: number;
  proposals: Map<number, Proposal>;
  votes: Map<string, Vote>;
  stakes: Map<string, Stake>;
  events: Map<number, Event>;
  eventCount: number;
  blockHeight: number;
  tokenBalances: Map<string, number>;
  totalStaked: number;
}

// Mock GovernanceToken trait
class GovernanceTokenMock {
  private balances: Map<string, number> = new Map();
  private holders: string[] = [];
  private minters: Map<string, boolean> = new Map([["dao", true]]);

  transfer(amount: number, sender: string, recipient: string): ClarityResponse<boolean> {
    const senderBalance = this.balances.get(sender) ?? 0;
    if (senderBalance < amount || amount <= 0) {
      return { ok: false, value: 108 }; // ERR-INVALID-AMOUNT
    }
    this.balances.set(sender, senderBalance - amount);
    const recipientBalance = this.balances.get(recipient) ?? 0;
    this.balances.set(recipient, recipientBalance + amount);
    if (!this.holders.includes(recipient)) {
      this.holders.push(recipient);
    }
    return { ok: true, value: true };
  }

  mint(amount: number, recipient: string): ClarityResponse<boolean> {
    if (!this.minters.get("dao")) {
      return { ok: false, value: 100 }; // ERR-NOT-AUTHORIZED
    }
    const recipientBalance = this.balances.get(recipient) ?? 0;
    this.balances.set(recipient, recipientBalance + amount);
    if (!this.holders.includes(recipient)) {
      this.holders.push(recipient);
    }
    return { ok: true, value: true };
  }

  getAllHolders(): string[] {
    return this.holders;
  }

  setInitialBalance(account: string, amount: number) {
    this.balances.set(account, amount);
    if (!this.holders.includes(account)) {
      this.holders.push(account);
    }
  }

  getBalance(account: string): number {
    return this.balances.get(account) ?? 0;
  }
}

// Mock DAOGovernance contract
class DAOGovernanceMock {
  private state: ContractState = {
    admin: "deployer",
    paused: false,
    quorumPercent: 10,
    thresholdPercent: 51,
    proposalCount: 0,
    treasuryStx: 0,
    treasuryFt: 0,
    proposals: new Map(),
    votes: new Map(),
    stakes: new Map(),
    events: new Map(),
    eventCount: 0,
    blockHeight: 1000,
    tokenBalances: new Map([["dao", 0]]),
    totalStaked: 0,
  };

  public tokenMock: GovernanceTokenMock;

  constructor() {
    this.tokenMock = new GovernanceTokenMock();
  }

  private VOTE_PERIOD = 1440;
  private LOCKUP_PERIOD = 144;
  private PROPOSAL_TYPE_FUND_RELEASE = 1;
  private PROPOSAL_TYPE_POLICY_CHANGE = 2;
  private PROPOSAL_TYPE_TOKEN_MINT = 3;

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_PROPOSAL_NOT_FOUND = 101;
  private ERR_VOTING_ENDED = 102;
  private ERR_VOTING_NOT_ENDED = 103;
  private ERR_ALREADY_VOTED = 104;
  private ERR_INSUFFICIENT_QUORUM = 105;
  private ERR_INSUFFICIENT_THRESHOLD = 106;
  private ERR_PAUSED = 107;
  private ERR_INVALID_AMOUNT = 108;
  private ERR_INVALID_PROPOSAL_TYPE = 109;
  private ERR_LOCKUP_NOT_EXPIRED = 110;
  private ERR_NO_STAKE = 111;
  private ERR_INVALID_STRING = 113;

  advanceBlock(blocks: number = 1) {
    this.state.blockHeight += blocks;
  }

  private emitEvent(eventType: string, data: string): number {
    const id = this.state.eventCount + 1;
    this.state.events.set(id, { timestamp: this.state.blockHeight, eventType, data });
    this.state.eventCount = id;
    return id;
  }

  private calculateQuorum(totalStaked: number): number {
    return Math.floor((totalStaked * this.state.quorumPercent) / 100);
  }

  private calculateThreshold(totalVotes: number): number {
    return Math.floor((totalVotes * this.state.thresholdPercent) / 100);
  }

  private getTotalStaked(): number {
    return this.state.totalStaked;
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.admin = newAdmin;
    this.emitEvent("admin-change", `New admin: ${newAdmin}`);
    return { ok: true, value: true };
  }

  pause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = true;
    this.emitEvent("pause", "DAO paused");
    return { ok: true, value: true };
  }

  unpause(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.paused = false;
    this.emitEvent("unpause", "DAO unpaused");
    return { ok: true, value: true };
  }

  setQuorumPercent(caller: string, newPercent: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (newPercent < 1 || newPercent > 100) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    this.state.quorumPercent = newPercent;
    this.emitEvent("param-change", `Quorum set to ${newPercent}`);
    return { ok: true, value: true };
  }

  setThresholdPercent(caller: string, newPercent: number): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (newPercent < 50 || newPercent > 100) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    this.state.thresholdPercent = newPercent;
    this.emitEvent("param-change", `Threshold set to ${newPercent}`);
    return { ok: true, value: true };
  }

  stake(caller: string, amount: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const transferResult = this.tokenMock.transfer(amount, caller, "dao");
    if (!transferResult.ok) {
      return transferResult;
    }
    const currentStake = this.state.stakes.get(caller) ?? { amount: 0, lockupEnd: 0 };
    const newStake = { amount: currentStake.amount + amount, lockupEnd: this.state.blockHeight + this.LOCKUP_PERIOD };
    this.state.stakes.set(caller, newStake);
    this.state.totalStaked += amount;
    this.emitEvent("stake", `${caller} staked ${amount}`);
    return { ok: true, value: true };
  }

  unstake(caller: string, amount: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const currentStake = this.state.stakes.get(caller);
    if (!currentStake) {
      return { ok: false, value: this.ERR_NO_STAKE };
    }
    if (amount > currentStake.amount) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    if (this.state.blockHeight < currentStake.lockupEnd) {
      return { ok: false, value: this.ERR_LOCKUP_NOT_EXPIRED };
    }
    const transferResult = this.tokenMock.transfer(amount, "dao", caller);
    if (!transferResult.ok) {
      return transferResult;
    }
    const newAmount = currentStake.amount - amount;
    if (newAmount === 0) {
      this.state.stakes.delete(caller);
    } else {
      this.state.stakes.set(caller, { amount: newAmount, lockupEnd: currentStake.lockupEnd });
    }
    this.state.totalStaked -= amount;
    this.emitEvent("unstake", `${caller} unstaked ${amount}`);
    return { ok: true, value: true };
  }

  createProposal(
    caller: string,
    description: string,
    proposalType: number,
    param1: number,
    param2: string,
    param3: string
  ): ClarityResponse<number> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (
      proposalType !== this.PROPOSAL_TYPE_FUND_RELEASE &&
      proposalType !== this.PROPOSAL_TYPE_POLICY_CHANGE &&
      proposalType !== this.PROPOSAL_TYPE_TOKEN_MINT
    ) {
      return { ok: false, value: this.ERR_INVALID_PROPOSAL_TYPE };
    }
    if (description.length > 256 || param3.length > 100) {
      return { ok: false, value: this.ERR_INVALID_STRING };
    }
    const stake = this.state.stakes.get(caller);
    if (!stake || stake.amount === 0) {
      return { ok: false, value: this.ERR_NO_STAKE };
    }
    const id = this.state.proposalCount + 1;
    this.state.proposals.set(id, {
      proposer: caller,
      description,
      proposalType,
      param1,
      param2,
      param3,
      yesVotes: 0,
      noVotes: 0,
      startBlock: this.state.blockHeight,
      endBlock: this.state.blockHeight + this.VOTE_PERIOD,
      executed: false,
    });
    this.state.proposalCount = id;
    this.emitEvent("proposal-created", `ID: ${id} Type: ${proposalType}`);
    return { ok: true, value: id };
  }

  vote(caller: string, proposalId: number, voteYes: boolean): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const proposal = this.state.proposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    if (this.state.blockHeight >= proposal.endBlock) {
      return { ok: false, value: this.ERR_VOTING_ENDED };
    }
    const voteKey = `${proposalId}-${caller}`;
    if (this.state.votes.has(voteKey)) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    const stake = this.state.stakes.get(caller);
    if (!stake || stake.amount === 0) {
      return { ok: false, value: this.ERR_NO_STAKE };
    }
    this.state.votes.set(voteKey, { voted: voteYes, amount: stake.amount });
    if (voteYes) {
      proposal.yesVotes += stake.amount;
    } else {
      proposal.noVotes += stake.amount;
    }
    this.state.proposals.set(proposalId, proposal);
    this.emitEvent("vote-cast", `Proposal ${proposalId} Voter: ${caller} Yes: ${voteYes}`);
    return { ok: true, value: true };
  }

  executeProposal(proposalId: number): ClarityResponse<boolean> {
    if (this.state.paused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    const proposal = this.state.proposals.get(proposalId);
    if (!proposal) {
      return { ok: false, value: this.ERR_PROPOSAL_NOT_FOUND };
    }
    if (this.state.blockHeight <= proposal.endBlock) {
      return { ok: false, value: this.ERR_VOTING_NOT_ENDED };
    }
    if (proposal.executed) {
      return { ok: false, value: this.ERR_ALREADY_VOTED };
    }
    const totalVotes = proposal.yesVotes + proposal.noVotes;
    const totalStaked = this.getTotalStaked();
    const quorum = this.calculateQuorum(totalStaked);
    const threshold = this.calculateThreshold(totalVotes);
    if (totalVotes < quorum) {
      return { ok: false, value: this.ERR_INSUFFICIENT_QUORUM };
    }
    if (proposal.yesVotes <= threshold) {
      return { ok: false, value: this.ERR_INSUFFICIENT_THRESHOLD };
    }
    proposal.executed = true;
    this.state.proposals.set(proposalId, proposal);

    let execResult: ClarityResponse<boolean>;
    switch (proposal.proposalType) {
      case this.PROPOSAL_TYPE_FUND_RELEASE:
        execResult = this.executeFundRelease(proposal);
        break;
      case this.PROPOSAL_TYPE_POLICY_CHANGE:
        execResult = this.executePolicyChange(proposal);
        break;
      case this.PROPOSAL_TYPE_TOKEN_MINT:
        execResult = this.executeTokenMint(proposal);
        break;
      default:
        return { ok: false, value: this.ERR_INVALID_PROPOSAL_TYPE };
    }
    if (!execResult.ok) {
      return { ok: false, value: 112 }; // ERR_EXECUTION_FAILED
    }
    this.emitEvent("proposal-executed", `ID: ${proposalId}`);
    return { ok: true, value: true };
  }

  private executeFundRelease(proposal: Proposal): ClarityResponse<boolean> {
    const amount = proposal.param1;
    const recipient = proposal.param2;
    if (amount <= 0 || this.state.treasuryStx < amount) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    this.state.treasuryStx -= amount;
    this.state.tokenBalances.set(recipient, (this.state.tokenBalances.get(recipient) ?? 0) + amount);
    return { ok: true, value: true };
  }

  private executePolicyChange(proposal: Proposal): ClarityResponse<boolean> {
    const key = proposal.param3;
    const value = proposal.param1;
    if (key === "quorum") {
      if (value < 1 || value > 100) {
        return { ok: false, value: this.ERR_INVALID_AMOUNT };
      }
      this.state.quorumPercent = value;
    } else if (key === "threshold") {
      if (value < 50 || value > 100) {
        return { ok: false, value: this.ERR_INVALID_AMOUNT };
      }
      this.state.thresholdPercent = value;
    } else {
      return { ok: false, value: this.ERR_INVALID_PROPOSAL_TYPE };
    }
    return { ok: true, value: true };
  }

  private executeTokenMint(proposal: Proposal): ClarityResponse<boolean> {
    const amount = proposal.param1;
    const recipient = proposal.param2;
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    return this.tokenMock.mint(amount, recipient);
  }

  depositTreasuryStx(caller: string, amount: number): ClarityResponse<number> {
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    this.state.treasuryStx += amount;
    this.state.tokenBalances.set(caller, (this.state.tokenBalances.get(caller) ?? 0) - amount);
    this.emitEvent("deposit", `STX deposited: ${amount}`);
    return { ok: true, value: amount };
  }

  depositTreasuryFt(caller: string, amount: number): ClarityResponse<number> {
    if (amount <= 0) {
      return { ok: false, value: this.ERR_INVALID_AMOUNT };
    }
    const transferResult = this.tokenMock.transfer(amount, caller, "dao");
    if (!transferResult.ok) {
      return { ok: false, value: typeof transferResult.value === "number" ? transferResult.value : this.ERR_INVALID_AMOUNT };
    }
    this.state.treasuryFt += amount;
    this.emitEvent("deposit", `FT deposited: ${amount}`);
    return { ok: true, value: amount };
  }

  getProposal(id: number): ClarityResponse<Proposal | null> {
    return { ok: true, value: this.state.proposals.get(id) ?? null };
  }

  getStake(user: string): ClarityResponse<Stake | null> {
    return { ok: true, value: this.state.stakes.get(user) ?? null };
  }

  getVote(proposalId: number, voter: string): ClarityResponse<Vote | null> {
    const voteKey = `${proposalId}-${voter}`;
    return { ok: true, value: this.state.votes.get(voteKey) ?? null };
  }

  getEvent(id: number): ClarityResponse<Event | null> {
    return { ok: true, value: this.state.events.get(id) ?? null };
  }

  getTreasuryBalance(): ClarityResponse<TreasuryBalance> {
    return { ok: true, value: { stx: this.state.treasuryStx, ft: this.state.treasuryFt } };
  }

  getConfig(): ClarityResponse<Config> {
    return {
      ok: true,
      value: {
        quorumPercent: this.state.quorumPercent,
        thresholdPercent: this.state.thresholdPercent,
        paused: this.state.paused,
      },
    };
  }

  setInitialTokenBalance(account: string, amount: number) {
    this.tokenMock.setInitialBalance(account, amount);
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  user1: "wallet_1",
  user2: "wallet_2",
  user3: "wallet_3",
};

describe("DAOGovernance Contract", () => {
  let contract: DAOGovernanceMock;

  beforeEach(() => {
    contract = new DAOGovernanceMock();
    contract.setInitialTokenBalance(accounts.user1, 10000);
    contract.setInitialTokenBalance(accounts.user2, 10000);
    contract.setInitialTokenBalance(accounts.user3, 10000);
    vi.resetAllMocks();
  });

  it("should allow admin to set new admin", () => {
    const result = contract.setAdmin(accounts.deployer, accounts.user1);
    expect(result).toEqual({ ok: true, value: true });
    const event = contract.getEvent(1).value;
    expect(event).not.toBeNull();
    if (event && typeof event !== "number") {
      expect(event.data).toBe(`New admin: ${accounts.user1}`);
    }
  });

  it("should prevent non-admin from setting admin", () => {
    const result = contract.setAdmin(accounts.user1, accounts.user2);
    expect(result).toEqual({ ok: false, value: 100 });
  });

  it("should allow admin to pause and unpause", () => {
    let result = contract.pause(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    const config = contract.getConfig().value;
    expect(config).not.toBeNull();
    if (config && typeof config !== "number") {
      expect(config).toEqual({
        quorumPercent: 10,
        thresholdPercent: 51,
        paused: true,
      });
    }

    result = contract.stake(accounts.user1, 1000);
    expect(result).toEqual({ ok: false, value: 107 });

    result = contract.unpause(accounts.deployer);
    expect(result).toEqual({ ok: true, value: true });
    const configAfter = contract.getConfig().value;
    expect(configAfter).not.toBeNull();
    if (configAfter && typeof configAfter !== "number") {
      expect(configAfter).toEqual({
        quorumPercent: 10,
        thresholdPercent: 51,
        paused: false,
      });
    }
  });

  it("should allow setting quorum and threshold by admin", () => {
    let result = contract.setQuorumPercent(accounts.deployer, 15);
    expect(result).toEqual({ ok: true, value: true });
    const config1 = contract.getConfig().value;
    expect(config1).not.toBeNull();
    if (config1 && typeof config1 !== "number") {
      expect(config1.quorumPercent).toBe(15);
    }

    result = contract.setThresholdPercent(accounts.deployer, 60);
    expect(result).toEqual({ ok: true, value: true });
    const config2 = contract.getConfig().value;
    expect(config2).not.toBeNull();
    if (config2 && typeof config2 !== "number") {
      expect(config2.thresholdPercent).toBe(60);
    }

    result = contract.setQuorumPercent(accounts.deployer, 0);
    expect(result).toEqual({ ok: false, value: 108 });
  });

  it("should allow staking and unstaking after lockup", () => {
    let result = contract.stake(accounts.user1, 5000);
    expect(result).toEqual({ ok: true, value: true });
    const stake = contract.getStake(accounts.user1).value;
    expect(stake).not.toBeNull();
    if (stake && typeof stake !== "number") {
      expect(stake).toEqual({ amount: 5000, lockupEnd: 1000 + 144 });
    }

    result = contract.unstake(accounts.user1, 1000);
    expect(result).toEqual({ ok: false, value: 110 });

    contract.advanceBlock(145);
    result = contract.unstake(accounts.user1, 2000);
    expect(result).toEqual({ ok: true, value: true });
    const stakeAfter = contract.getStake(accounts.user1).value;
    expect(stakeAfter).not.toBeNull();
    if (stakeAfter && typeof stakeAfter !== "number") {
      expect(stakeAfter).toEqual({ amount: 3000, lockupEnd: 1144 });
    }
  });

  it("should prevent unstaking without stake or insufficient amount", () => {
    const result = contract.unstake(accounts.user1, 1000);
    expect(result).toEqual({ ok: false, value: 111 });
  });

  it("should allow creating proposal with valid inputs", () => {
    contract.stake(accounts.user1, 1000);
    const result = contract.createProposal(
      accounts.user1,
      "Test proposal",
      1,
      500,
      accounts.user2,
      "test"
    );
    expect(result).toEqual({ ok: true, value: 1 });
    const proposal = contract.getProposal(1).value;
    expect(proposal).not.toBeNull();
    if (proposal && typeof proposal !== "number") {
      expect(proposal).toMatchObject({
        proposer: accounts.user1,
        proposalType: 1,
        param1: 500,
        param2: accounts.user2,
        param3: "test",
        executed: false,
      });
    }
  });

  it("should prevent proposal creation with invalid inputs", () => {
    let result = contract.createProposal(
      accounts.user1,
      "Invalid",
      1,
      0,
      accounts.user2,
      ""
    );
    expect(result).toEqual({ ok: false, value: 111 });

    contract.stake(accounts.user1, 1000);
    result = contract.createProposal(
      accounts.user1,
      "Invalid type",
      99,
      0,
      accounts.user2,
      ""
    );
    expect(result).toEqual({ ok: false, value: 109 });

    result = contract.createProposal(
      accounts.user1,
      "a".repeat(257),
      1,
      0,
      accounts.user2,
      ""
    );
    expect(result).toEqual({ ok: false, value: 113 });
  });

  it("should allow voting on active proposal", () => {
    contract.stake(accounts.user1, 1000);
    contract.stake(accounts.user2, 2000);
    contract.createProposal(
      accounts.user1,
      "Test",
      1,
      500,
      accounts.user3,
      ""
    );

    let result = contract.vote(accounts.user2, 1, true);
    expect(result).toEqual({ ok: true, value: true });
    const vote = contract.getVote(1, accounts.user2).value;
    expect(vote).not.toBeNull();
    if (vote && typeof vote !== "number") {
      expect(vote).toEqual({ voted: true, amount: 2000 });
    }
    const proposal = contract.getProposal(1).value;
    expect(proposal).not.toBeNull();
    if (proposal && typeof proposal !== "number") {
      expect(proposal.yesVotes).toBe(2000);
    }

    result = contract.vote(accounts.user2, 1, false);
    expect(result).toEqual({ ok: false, value: 104 });
  });

  it("should prevent voting after end or without stake", () => {
    contract.stake(accounts.user1, 1000);
    contract.createProposal(
      accounts.user1,
      "Test",
      1,
      500,
      accounts.user3,
      ""
    );

    contract.advanceBlock(1441);
    const result = contract.vote(accounts.user1, 1, true);
    expect(result).toEqual({ ok: false, value: 102 });
  });

  it("should execute proposal if quorum and threshold met", () => {
    contract.stake(accounts.user1, 1000);
    contract.stake(accounts.user2, 2000);
    contract.stake(accounts.user3, 3000);
    contract.depositTreasuryStx(accounts.deployer, 10000);

    contract.createProposal(
      accounts.user1,
      "Fund release",
      1,
      5000,
      accounts.user3,
      ""
    );

    contract.vote(accounts.user2, 1, true);
    contract.vote(accounts.user3, 1, true);

    contract.advanceBlock(1441);

    const result = contract.executeProposal(1);
    expect(result).toEqual({ ok: true, value: true });
    const proposal = contract.getProposal(1).value;
    expect(proposal).not.toBeNull();
    if (proposal && typeof proposal !== "number") {
      expect(proposal.executed).toBe(true);
    }
    const balance = contract.getTreasuryBalance().value;
    expect(balance).not.toBeNull();
    if (balance && typeof balance !== "number") {
      expect(balance.stx).toBe(5000);
    }
  });

  it("should fail execution if quorum or threshold not met", () => {
    contract.stake(accounts.user1, 1000);
    contract.stake(accounts.user2, 2000);
    contract.createProposal(
      accounts.user1,
      "Test",
      1,
      500,
      accounts.user3,
      ""
    );

    contract.vote(accounts.user2, 1, false);

    contract.advanceBlock(1441);

    const result = contract.executeProposal(1);
    expect(result).toEqual({ ok: false, value: 106 });
  });

  it("should execute policy change proposal", () => {
    contract.stake(accounts.user1, 1000);
    contract.stake(accounts.user2, 9000);
    contract.createProposal(
      accounts.user1,
      "Change quorum",
      2,
      20,
      accounts.user3,
      "quorum"
    );

    contract.vote(accounts.user2, 1, true);

    contract.advanceBlock(1441);

    const result = contract.executeProposal(1);
    expect(result).toEqual({ ok: true, value: true });
    const config = contract.getConfig().value;
    expect(config).not.toBeNull();
    if (config && typeof config !== "number") {
      expect(config.quorumPercent).toBe(20);
    }
  });

  it("should execute token mint proposal", () => {
    contract.stake(accounts.user1, 1000);
    contract.stake(accounts.user2, 9000);
    contract.createProposal(
      accounts.user1,
      "Mint tokens",
      3,
      10000,
      accounts.user3,
      ""
    );

    contract.vote(accounts.user2, 1, true);

    contract.advanceBlock(1441);

    const result = contract.executeProposal(1);
    expect(result).toEqual({ ok: true, value: true });
    expect(contract.tokenMock.getBalance(accounts.user3)).toBe(20000); // Initial 10000 + minted 10000
  });

  it("should allow depositing to treasury", () => {
    let result = contract.depositTreasuryStx(accounts.user1, 5000);
    expect(result).toEqual({ ok: true, value: 5000 });
    const balance1 = contract.getTreasuryBalance().value;
    expect(balance1).not.toBeNull();
    if (balance1 && typeof balance1 !== "number") {
      expect(balance1.stx).toBe(5000);
    }

    result = contract.depositTreasuryFt(accounts.user1, 3000);
    expect(result).toEqual({ ok: true, value: 3000 });
    const balance2 = contract.getTreasuryBalance().value;
    expect(balance2).not.toBeNull();
    if (balance2 && typeof balance2 !== "number") {
      expect(balance2.ft).toBe(3000);
    }
  });

  it("should emit events correctly", () => {
    contract.stake(accounts.user1, 1000);
    const event = contract.getEvent(1).value;
    expect(event).not.toBeNull();
    if (event && typeof event !== "number") {
      expect(event.eventType).toBe("stake");
    }
  });
});