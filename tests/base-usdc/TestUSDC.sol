// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.35;

// Test fixture only. Never deploy this mintable token outside the isolated Anvil chain.
contract TestUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }
    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external {
        require(block.timestamp > validAfter && block.timestamp < validBefore, "time");
        require(!authorizationState[from][nonce], "used");
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("USD Coin"), keccak256("2"), block.chainid, address(this)));
        bytes32 message = keccak256(abi.encode(
            keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"),
            from, to, value, validAfter, validBefore, nonce));
        address signer = ecrecover(keccak256(abi.encodePacked(hex"1901", domain, message)), v, r, s);
        require(signer != address(0) && signer == from, "signature");
        require(balanceOf[from] >= value, "balance");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit AuthorizationUsed(from, nonce);
        emit Transfer(from, to, value);
    }
}
