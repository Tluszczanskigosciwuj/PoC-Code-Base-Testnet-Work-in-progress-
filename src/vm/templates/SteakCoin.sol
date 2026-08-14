// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract SteakCoin {
    string public constant name = "STEAK";
    string public constant symbol = "STEAK";
    uint8 public constant decimals = 18;

    uint256 public constant INITIAL_SUPPLY = 21_000_000 * 10 ** decimals;
    uint256 public totalSupply;

    uint256 public constant REWARDS_RESERVE = (INITIAL_SUPPLY * 10) / 100;
    uint256 public constant CREATOR_IMMEDIATE = (INITIAL_SUPPLY * 15) / 100;
    uint256 public constant CREATOR_VESTING_TOTAL = INITIAL_SUPPLY - REWARDS_RESERVE - CREATOR_IMMEDIATE;

    uint256 public constant REWARDS_DURATION = 4 * 365 days;
    uint256 public constant VESTING_DURATION = 365 days;

    uint256 public immutable rewardRate;
    address public immutable creator;
    uint256 public immutable deployedAt;

    uint256 public rewardsReserveRemaining;
    uint256 public creatorVestingClaimed;

    uint256 public constant TRANSFER_BURN_BPS = 100;   // 1% queimado de verdade (supply cai)
    uint256 public constant TRANSFER_SIZZLE_BPS = 50;  // 0.5% vai pro sizzle pool (burn manual)
    uint256 public sizzlePool; // acumulado à espera de alguém chamar sizzle()

    uint256 public constant MAX_TX_BPS = 100;      // 1% do supply inicial por tx
    uint256 public constant MAX_WALLET_BPS = 200;  // 2% do supply inicial por carteira
    mapping(address => bool) public isWhaleExempt;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public constant NUM_TIERS = 4;
    uint256[NUM_TIERS] public tierLock;
    uint256[NUM_TIERS] public tierMultiplier; // escala 1e18

    uint256 public constant EARLY_EXIT_FEE_BPS = 500; // 5% de multa saindo antes do lock

    struct StakePosition {
        uint256 amount;     // principal staked (não ponderado)
        uint256 weighted;   // amount * multiplier / 1e18 — usado no cálculo de recompensa
        uint8 tier;
        uint256 lockUntil;
        address referrer;
    }

    mapping(address => StakePosition) public stakes;
    uint256 public totalStaked;         // soma de amount (não ponderado) — informativo
    uint256 public totalWeightedStaked; // soma ponderada — usado no reward accounting

    // Synthetix-style reward accounting, mas sobre saldo PONDERADO.
    uint256 public rewardPerTokenStored;
    uint256 public lastUpdateTime;
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;

    uint256 public constant REFERRAL_BONUS_BPS = 500; // 5% extra pro referrer, por cima (sai da reserva)

    bool private _locked;

    struct Proposal {
        string description;
        uint256 endTime;
        uint256 forVotes;
        uint256 againstVotes;
        mapping(address => bool) hasVoted;
    }
    uint256 public proposalCount;
    mapping(uint256 => Proposal) private _proposals;
    uint256 public constant MIN_STAKE_TO_PROPOSE = 1_000 * 10 ** decimals;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Burn(address indexed from, uint256 amount);
    event Sizzle(address indexed caller, uint256 amount);

    event Stake(address indexed user, uint256 amount, uint8 tier, address referrer);
    event Unstake(address indexed user, uint256 amount, uint256 fee);
    event RewardClaimed(address indexed user, uint256 amount, uint256 referralBonus);
    event Compounded(address indexed user, uint256 amount);

    event ProposalCreated(uint256 indexed id, address indexed proposer, string description, uint256 endTime);
    event Voted(uint256 indexed id, address indexed voter, bool support, uint256 weight);

    event CreatorVestClaimed(uint256 amount);

    modifier nonReentrant() {
        require(!_locked, "STEAK: reentrancy");
        _locked = true;
        _;
        _locked = false;
    }

    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    constructor() {
        creator = msg.sender;
        deployedAt = block.timestamp;
        lastUpdateTime = block.timestamp;

        totalSupply = INITIAL_SUPPLY;
        rewardRate = REWARDS_RESERVE / REWARDS_DURATION;
        rewardsReserveRemaining = REWARDS_RESERVE;

        balanceOf[creator] = CREATOR_IMMEDIATE;
        balanceOf[address(this)] = REWARDS_RESERVE + CREATOR_VESTING_TOTAL;

        emit Transfer(address(0), creator, CREATOR_IMMEDIATE);
        emit Transfer(address(0), address(this), REWARDS_RESERVE + CREATOR_VESTING_TOTAL);

        isWhaleExempt[address(this)] = true;
        isWhaleExempt[creator] = true;

        tierLock[0] = 0;          tierMultiplier[0] = 1e18;
        tierLock[1] = 7 days;     tierMultiplier[1] = 1.25e18;
        tierLock[2] = 30 days;    tierMultiplier[2] = 1.5e18;
        tierLock[3] = 90 days;    tierMultiplier[3] = 2e18;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "STEAK: allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "STEAK: zero address");
        require(from != address(this), "STEAK: locked in contract");
        require(balanceOf[from] >= amount, "STEAK: insufficient balance");
        require(amount <= (INITIAL_SUPPLY * MAX_TX_BPS) / 10_000, "STEAK: exceeds max tx");

        uint256 burnFee = (amount * TRANSFER_BURN_BPS) / 10_000;
        uint256 sizzleFee = (amount * TRANSFER_SIZZLE_BPS) / 10_000;
        uint256 net = amount - burnFee - sizzleFee;

        if (!isWhaleExempt[to]) {
            require(balanceOf[to] + net <= (INITIAL_SUPPLY * MAX_WALLET_BPS) / 10_000, "STEAK: exceeds max wallet");
        }

        balanceOf[from] -= amount;
        balanceOf[to] += net;
        emit Transfer(from, to, net);

        if (burnFee > 0) {
            totalSupply -= burnFee;
            emit Transfer(from, address(0), burnFee);
            emit Burn(from, burnFee);
        }
        if (sizzleFee > 0) {
            balanceOf[address(this)] += sizzleFee;
            sizzlePool += sizzleFee;
            emit Transfer(from, address(this), sizzleFee);
        }
    }

    function sizzle() external {
        uint256 amount = sizzlePool;
        require(amount > 0, "STEAK: nothing to sizzle");

        sizzlePool = 0;
        balanceOf[address(this)] -= amount;
        totalSupply -= amount;

        emit Transfer(address(this), address(0), amount);
        emit Burn(address(this), amount);
        emit Sizzle(msg.sender, amount);
    }

    function rewardsEndTime() public view returns (uint256) {
        return deployedAt + REWARDS_DURATION;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < rewardsEndTime() ? block.timestamp : rewardsEndTime();
    }

    function rewardPerToken() public view returns (uint256) {
        if (totalWeightedStaked == 0) return rewardPerTokenStored;
        uint256 elapsed = lastTimeRewardApplicable() - lastUpdateTime;
        return rewardPerTokenStored + (elapsed * rewardRate * 1e18) / totalWeightedStaked;
    }

    function earned(address account) public view returns (uint256) {
        uint256 delta = rewardPerToken() - userRewardPerTokenPaid[account];
        return rewards[account] + (stakes[account].weighted * delta) / 1e18;
    }

    function stake(uint256 amount, uint8 tier, address referrer) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "STEAK: zero amount");
        require(tier < NUM_TIERS, "STEAK: invalid tier");
        require(balanceOf[msg.sender] >= amount, "STEAK: insufficient balance");

        StakePosition storage pos = stakes[msg.sender];
        if (pos.amount > 0) {
            require(pos.tier == tier, "STEAK: must match existing tier (unstake first to switch)");
        } else if (referrer != address(0) && referrer != msg.sender) {
            pos.referrer = referrer;
        }

        uint256 weightedAmount = (amount * tierMultiplier[tier]) / 1e18;

        balanceOf[msg.sender] -= amount;
        pos.amount += amount;
        pos.weighted += weightedAmount;
        pos.tier = tier;
        pos.lockUntil = block.timestamp + tierLock[tier];

        totalStaked += amount;
        totalWeightedStaked += weightedAmount;

        emit Stake(msg.sender, amount, tier, pos.referrer);
        emit Transfer(msg.sender, address(this), amount);
    }

    function unstake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        StakePosition storage pos = stakes[msg.sender];
        require(amount > 0 && amount <= pos.amount, "STEAK: invalid amount");

        uint256 weightedOut = (pos.weighted * amount) / pos.amount;

        pos.amount -= amount;
        pos.weighted -= weightedOut;
        totalStaked -= amount;
        totalWeightedStaked -= weightedOut;

        uint256 fee = 0;
        if (block.timestamp < pos.lockUntil) {
            fee = (amount * EARLY_EXIT_FEE_BPS) / 10_000;
        }
        uint256 net = amount - fee;
        balanceOf[msg.sender] += net;
        emit Transfer(address(this), msg.sender, net);

        if (fee > 0) {
            balanceOf[address(this)] += fee;
            rewardsReserveRemaining += fee; // multa reforça o pool de recompensas
        }

        emit Unstake(msg.sender, amount, fee);
    }

    function claimReward() external nonReentrant updateReward(msg.sender) {
        _claimRewardFor(msg.sender);
    }

    function _claimRewardFor(address user) internal {
        uint256 reward = rewards[user];
        require(reward > 0, "STEAK: no reward");
        require(rewardsReserveRemaining >= reward, "STEAK: reserve depleted");

        rewards[user] = 0;
        rewardsReserveRemaining -= reward;
        balanceOf[address(this)] -= reward;
        balanceOf[user] += reward;

        uint256 referralBonus = 0;
        address ref = stakes[user].referrer;
        if (ref != address(0)) {
            referralBonus = (reward * REFERRAL_BONUS_BPS) / 10_000;
            if (referralBonus > rewardsReserveRemaining) referralBonus = rewardsReserveRemaining;
            if (referralBonus > 0) {
                rewardsReserveRemaining -= referralBonus;
                balanceOf[address(this)] -= referralBonus;
                balanceOf[ref] += referralBonus;
                emit Transfer(address(this), ref, referralBonus);
            }
        }

        emit RewardClaimed(user, reward, referralBonus);
        emit Transfer(address(this), user, reward);
    }

    function compound() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        require(reward > 0, "STEAK: no reward");
        require(rewardsReserveRemaining >= reward, "STEAK: reserve depleted");

        StakePosition storage pos = stakes[msg.sender];
        require(pos.amount > 0, "STEAK: no active stake");

        rewards[msg.sender] = 0;
        rewardsReserveRemaining -= reward;
        balanceOf[address(this)] -= reward; // sai do "balanço livre" do contrato...
        // ...e volta direto pro stake do usuário (sem transitar por balanceOf[user]).
        uint256 weightedAmount = (reward * tierMultiplier[pos.tier]) / 1e18;

        pos.amount += reward;
        pos.weighted += weightedAmount;
        pos.lockUntil = block.timestamp + tierLock[pos.tier];

        totalStaked += reward;
        totalWeightedStaked += weightedAmount;

        emit Compounded(msg.sender, reward);
        emit Transfer(address(this), msg.sender, reward);
        emit Transfer(msg.sender, address(this), reward);
    }

    function exit() external nonReentrant updateReward(msg.sender) {
        if (rewards[msg.sender] > 0) {
            _claimRewardFor(msg.sender);
        }

        StakePosition storage pos = stakes[msg.sender];
        uint256 amount = pos.amount;
        require(amount > 0, "STEAK: nothing staked");

        pos.amount = 0;
        totalStaked -= amount;
        totalWeightedStaked -= pos.weighted;
        pos.weighted = 0;

        uint256 fee = 0;
        if (block.timestamp < pos.lockUntil) {
            fee = (amount * EARLY_EXIT_FEE_BPS) / 10_000;
        }
        uint256 net = amount - fee;
        balanceOf[msg.sender] += net;
        emit Transfer(address(this), msg.sender, net);

        if (fee > 0) {
            balanceOf[address(this)] += fee;
            rewardsReserveRemaining += fee;
        }

        emit Unstake(msg.sender, amount, fee);
    }

    function creatorVestedTotal() public view returns (uint256) {
        uint256 elapsed = block.timestamp - deployedAt;
        if (elapsed >= VESTING_DURATION) return CREATOR_VESTING_TOTAL;
        return (CREATOR_VESTING_TOTAL * elapsed) / VESTING_DURATION;
    }

    function creatorClaimable() public view returns (uint256) {
        return creatorVestedTotal() - creatorVestingClaimed;
    }

    function claimVested() external nonReentrant {
        require(msg.sender == creator, "STEAK: only creator");
        uint256 claimable = creatorClaimable();
        require(claimable > 0, "STEAK: nothing vested yet");

        creatorVestingClaimed += claimable;
        balanceOf[address(this)] -= claimable;
        balanceOf[creator] += claimable;

        emit CreatorVestClaimed(claimable);
        emit Transfer(address(this), creator, claimable);
    }

    function createProposal(string calldata description, uint256 duration) external returns (uint256 id) {
        require(stakes[msg.sender].amount >= MIN_STAKE_TO_PROPOSE, "STEAK: stake too low to propose");
        require(duration >= 1 days && duration <= 30 days, "STEAK: bad duration");

        id = proposalCount++;
        Proposal storage p = _proposals[id];
        p.description = description;
        p.endTime = block.timestamp + duration;

        emit ProposalCreated(id, msg.sender, description, p.endTime);
    }

    function vote(uint256 id, bool support) external {
        Proposal storage p = _proposals[id];
        require(p.endTime != 0, "STEAK: unknown proposal");
        require(block.timestamp < p.endTime, "STEAK: voting closed");
        require(!p.hasVoted[msg.sender], "STEAK: already voted");

        uint256 weight = stakes[msg.sender].amount;
        require(weight > 0, "STEAK: no voting power (stake something)");

        p.hasVoted[msg.sender] = true;
        if (support) p.forVotes += weight; else p.againstVotes += weight;

        emit Voted(id, msg.sender, support, weight);
    }

    function proposalInfo(uint256 id)
        external
        view
        returns (string memory description, uint256 endTime, uint256 forVotes, uint256 againstVotes)
    {
        Proposal storage p = _proposals[id];
        return (p.description, p.endTime, p.forVotes, p.againstVotes);
    }
}
