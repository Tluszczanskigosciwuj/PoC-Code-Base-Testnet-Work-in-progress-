// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DOGU — meme coin PoW
contract DoguToken {
    string public constant name = "Dogu";
    string public constant symbol = "DOGU";
    uint8 public constant decimals = 8;

    uint256 public constant TOTAL_SUPPLY = 21_000_000_000 * 10 ** decimals;
    uint256 public constant PREMINE = TOTAL_SUPPLY / 100;
    uint256 public constant MINING_RESERVE = TOTAL_SUPPLY - PREMINE;

    address public immutable creator;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    uint256 public constant INITIAL_REWARD = 5_000 * 10 ** decimals;
    uint256 public constant HALVING_INTERVAL_PROOFS = 2_100_000;
    uint256 public constant TARGET_INTERVAL = 20 seconds;
    uint256 public constant NETWORK_EPOCH_PROOFS = 180;
    uint256 public constant MAX_RETARGET_FACTOR = 4;
    uint256 public constant MAX_EASE_SHIFT = 24;
    uint256 public constant BOOTSTRAP_EASE_SHIFT = 10;

    uint256 public constant BURN_UNIT = 1_000 * 10 ** decimals;
    uint256 public constant BURN_DISCOUNT_BPS = 500;
    uint256 public constant MAX_BURN_UNITS_PER_CALL = 20;

    uint256 public constant GOLDEN_THRESHOLD = type(uint256).max >> 32; // ~8 zeros hex
    uint256 public constant JACKPOT_SKIM_BPS = 100;
    uint256 public jackpotPool;

    uint256 public networkTarget;
    uint256 public epochStartTime;
    uint256 public proofsInEpoch;
    uint256 public totalProofsAccepted;
    uint256 public totalMined;

    bytes32 public immutable globalSalt;
    mapping(address => uint256) public personalTarget;
    mapping(address => uint256) public minerProofCount;
    mapping(address => uint256) public lastSubmitTime;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ProofAccepted(address indexed miner, uint256 reward, uint256 personalTargetUsed, uint256 networkTargetAtTime, uint256 newPersonalTarget);
    event NetworkRetarget(uint256 oldTarget, uint256 newTarget, uint256 elapsed, uint256 expected);
    event DifficultyBurned(address indexed miner, uint256 units, uint256 newPersonalTarget);
    event GoldenNonceFound(address indexed miner, uint256 jackpot, bytes32 hash);
    event Burn(address indexed from, uint256 amount);

    constructor() {
        creator = msg.sender;
        globalSalt = keccak256(abi.encodePacked(address(this), block.number, block.timestamp));

        totalSupply = TOTAL_SUPPLY;
        balanceOf[creator] = PREMINE;
        balanceOf[address(this)] = MINING_RESERVE;
        emit Transfer(address(0), creator, PREMINE);
        emit Transfer(address(0), address(this), MINING_RESERVE);

        networkTarget = type(uint256).max >> 8;
        epochStartTime = block.timestamp;
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
        require(allowed >= amount, "DOGU: allowance exceeded");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(to != address(0), "DOGU: zero address");
        require(from != address(this), "DOGU: locked in mining reserve");
        require(balanceOf[from] >= amount, "DOGU: insufficient balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function doguAddress(address account) external pure returns (string memory) {
        bytes memory hexChars = "0123456789abcdef";
        bytes20 addrBytes = bytes20(account);
        bytes memory out = new bytes(5 + 40);
        out[0] = "d"; out[1] = "o"; out[2] = "g"; out[3] = "u"; out[4] = "_";
        for (uint256 i = 0; i < 20; i++) {
            out[5 + i * 2] = hexChars[uint8(addrBytes[i] >> 4)];
            out[6 + i * 2] = hexChars[uint8(addrBytes[i] & 0x0f)];
        }
        return string(out);
    }

    function currentBaseReward() public view returns (uint256) {
        uint256 halvings = totalProofsAccepted / HALVING_INTERVAL_PROOFS;
        if (halvings >= 64) return 0;
        return INITIAL_REWARD >> halvings;
    }

    function personalTargetOf(address miner) public view returns (uint256) {
        uint256 t = personalTarget[miner];
        if (t == 0) t = _boundedEase(networkTarget, BOOTSTRAP_EASE_SHIFT);
        if (t < networkTarget) t = networkTarget;
        uint256 maxEase = _boundedEase(networkTarget, MAX_EASE_SHIFT);
        if (t > maxEase) t = maxEase;
        return t;
    }

    function _boundedEase(uint256 target, uint256 shift) internal pure returns (uint256) {
        if (shift >= 256) return type(uint256).max;
        uint256 maxSafe = type(uint256).max >> shift;
        if (target > maxSafe) return type(uint256).max;
        return target << shift;
    }

    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        uint256 prod0;
        uint256 prod1;
        uint256 remainder;
        uint256 twos;
        uint256 inverse;
        unchecked {
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 >= denominator) revert("DOGU: MulDivOverflow");
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            inverse *= 2 - denominator * inverse;
            result = prod0 * inverse;
        }
    }

    function burnToLowerDifficulty(uint256 units) external {
        require(units > 0 && units <= MAX_BURN_UNITS_PER_CALL, "DOGU: invalid units");
        uint256 cost = units * BURN_UNIT;
        require(balanceOf[msg.sender] >= cost, "DOGU: insufficient balance");

        uint256 newTarget = personalTargetOf(msg.sender);
        uint256 maxEase = _boundedEase(networkTarget, MAX_EASE_SHIFT);
        for (uint256 i = 0; i < units; i++) {
            uint256 inc = newTarget / 20;
            if (newTarget > maxEase - inc) { newTarget = maxEase; break; }
            newTarget += inc;
        }
        if (newTarget > maxEase) newTarget = maxEase;
        personalTarget[msg.sender] = newTarget;

        balanceOf[msg.sender] -= cost;
        totalSupply -= cost;
        emit Transfer(msg.sender, address(0), cost);
        emit Burn(msg.sender, cost);
        emit DifficultyBurned(msg.sender, units, newTarget);
    }

    function mine(uint256 nonce) external {
        uint256 target = personalTargetOf(msg.sender);

        bytes32 h = keccak256(abi.encodePacked(globalSalt, msg.sender, minerProofCount[msg.sender], nonce));
        require(uint256(h) <= target, "DOGU: proof does not meet target");

        uint256 base = currentBaseReward();
        uint256 reward = target == 0 ? base : _mulDiv(base, networkTarget, target);
        if (reward > base) reward = base;

        uint256 remaining = MINING_RESERVE - totalMined;
        if (reward > remaining) reward = remaining;

        minerProofCount[msg.sender] += 1;
        totalProofsAccepted += 1;
        totalMined += reward;

        if (reward > 0) {
            uint256 skim = (reward * JACKPOT_SKIM_BPS) / 10_000;
            uint256 payout = reward - skim;
            jackpotPool += skim;
            balanceOf[address(this)] -= reward;
            balanceOf[msg.sender] += payout;
            emit Transfer(address(this), msg.sender, payout);
        }

        if (uint256(h) <= GOLDEN_THRESHOLD && jackpotPool > 0) {
            uint256 jackpot = jackpotPool;
            jackpotPool = 0;
            balanceOf[address(this)] -= jackpot;
            balanceOf[msg.sender] += jackpot;
            emit Transfer(address(this), msg.sender, jackpot);
            emit GoldenNonceFound(msg.sender, jackpot, h);
        }

        uint256 last = lastSubmitTime[msg.sender];
        uint256 elapsed = last == 0 ? TARGET_INTERVAL : block.timestamp - last;
        if (elapsed == 0) elapsed = 1;

        uint256 newTarget = _mulDiv(target, elapsed, TARGET_INTERVAL);
        uint256 lowerTarget = target / 4;
        uint256 upperTarget = target > type(uint256).max / 4 ? type(uint256).max : target * 4;
        if (newTarget > upperTarget) newTarget = upperTarget;
        if (newTarget < lowerTarget) newTarget = lowerTarget;
        if (newTarget < networkTarget) newTarget = networkTarget;
        uint256 maxEase = _boundedEase(networkTarget, MAX_EASE_SHIFT);
        if (newTarget > maxEase) newTarget = maxEase;

        personalTarget[msg.sender] = newTarget;
        lastSubmitTime[msg.sender] = block.timestamp;

        emit ProofAccepted(msg.sender, reward, target, networkTarget, newTarget);

        proofsInEpoch += 1;
        if (proofsInEpoch >= NETWORK_EPOCH_PROOFS) {
            uint256 elapsedEpoch = block.timestamp - epochStartTime;
            if (elapsedEpoch == 0) elapsedEpoch = 1;
            uint256 expectedEpoch = NETWORK_EPOCH_PROOFS * TARGET_INTERVAL;

            uint256 oldNetworkTarget = networkTarget;
            uint256 newNetworkTarget = _mulDiv(oldNetworkTarget, elapsedEpoch, expectedEpoch);

            uint256 upperClamp = oldNetworkTarget > type(uint256).max / MAX_RETARGET_FACTOR ? type(uint256).max : oldNetworkTarget * MAX_RETARGET_FACTOR;
            uint256 lowerClamp = oldNetworkTarget / MAX_RETARGET_FACTOR;
            if (newNetworkTarget > upperClamp) newNetworkTarget = upperClamp;
            if (newNetworkTarget < lowerClamp) newNetworkTarget = lowerClamp;
            if (newNetworkTarget == 0) newNetworkTarget = 1;

            networkTarget = newNetworkTarget;
            proofsInEpoch = 0;
            epochStartTime = block.timestamp;

            emit NetworkRetarget(oldNetworkTarget, newNetworkTarget, elapsedEpoch, expectedEpoch);
        }
    }
}
