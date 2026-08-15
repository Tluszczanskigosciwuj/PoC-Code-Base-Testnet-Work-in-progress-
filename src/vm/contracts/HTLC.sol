// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
contract HTLC {
    bytes32 public hashlock;
    uint256 public timelock;
    address public sender;
    address public receiver;
    uint256 public amount;
    bool public redeemed;
    bool public refunded;

    constructor(address _receiver, bytes32 _hashlock, uint256 _timelock) payable {
        sender = msg.sender;
        receiver = _receiver;
        hashlock = _hashlock;
        timelock = _timelock;
        amount = msg.value;
    }

    function redeem(bytes32 _preimage) external {
        require(sha256(abi.encodePacked(_preimage)) == hashlock, 'bad preimage');
        require(msg.sender == receiver, 'not receiver');
        require(!redeemed, 'already redeemed');
        redeemed = true;
        payable(receiver).transfer(amount);
    }

    function refund() external {
        require(block.timestamp > timelock, 'timelock not reached');
        require(msg.sender == sender, 'not sender');
        require(!refunded, 'already refunded');
        refunded = true;
        payable(sender).transfer(amount);
    }
}
