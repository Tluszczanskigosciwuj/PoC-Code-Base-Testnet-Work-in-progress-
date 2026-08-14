# Template STEAK — Coin PoS

Coin Proof-of-Stake minimalista: supply fixo, transferências, staking e unstaking. **Sem owner** — ninguém controla o contrato além do próprio código.

- Nome: `STEAK`
- Símbolo: `STEAK`
- Decimals: 18
- Total supply: 21.000.000 STEAK (todo para o criador no deploy)
- Formato de endereço do sistema: `0xcc` + 40 hex (21 bytes)

## Funcionalidades

| Função | Descrição |
|---|---|
| `balanceOf(address)` | Saldo livre de um endereço |
| `stakedBalanceOf(address)` | Valor travado (staked) de um endereço |
| `transfer(to, amount)` | Envia STEAK livre |
| `stake(amount)` | Trava STEAK (sai de balanceOf, entra em stakedBalanceOf) |
| `unstake(amount)` | Libera STEAK de volta para balanceOf |

> Sem `owner` e sem `mint`: ninguém (nem o criador) pode criar STEAK depois do deploy.
> O campo `creator` na tabela `smart_contracts` é apenas metadado de rastreio — não dá controle.

## Arquivos

- `SteakCoin.sol` — código-fonte Solidity (referência)
- `SteakCoin.bytecode.json` — ABI + bytecode compilado (usado no deploy)
- `deploy-steak.js` — CLI para deploy e interação

## Deploy

```bash
node src/vm/templates/deploy-steak.js deploy <senderAddress> [nonce]
```

Exemplo (do diretório do projeto):

```bash
node src/vm/templates/deploy-steak.js deploy 0xcc35f3f53ea376ad13a035c2f095a1ffce4f6ce201
```

## Comandos

```bash
C=0xcc<address_do_contrato>
S=0xcc35f3f53ea376ad13a035c2f095a1ffce4f6ce201
B=0xcc2222222222222222222222222222222222222222

# saldo
node src/vm/templates/deploy-steak.js balance $C $S $S
# transferir 100
node src/vm/templates/deploy-steak.js transfer $C $S $B 100
# travar 50
node src/vm/templates/deploy-steak.js stake $C $S 50
# ver staked
node src/vm/templates/deploy-steak.js staked $C $S $S
# liberar 50
node src/vm/templates/deploy-steak.js unstake $C $S 50
# info do contrato (do DB)
node src/vm/templates/deploy-steak.js info $C
```

## Como funciona por baixo

1. O init code roda; o que ele `RETURN` vira o **runtime code** persistido no DB.
2. O storage (balances, stakes) é persistido na tabela `smart_contract_storage`, slot a slot, usando o evento `step` (SSTORE) do ethereumjs-vm.
3. Endereço do contrato é derivado de `sender + nonce` (`generateAddress`), no formato `0xcc` + 40 hex do sistema.
4. Chamadas ABI usam o endereço EVM de 20 bytes (o prefixo `0xcc` é descartado só dentro do VM).

## Recompilação (se editar o .sol)

```bash
node -e "
const solc = require('solc');
const fs = require('fs');
const source = fs.readFileSync('src/vm/templates/SteakCoin.sol', 'utf8');
const input = {
  language: 'Solidity',
  sources: { 'SteakCoin.sol': { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'petersburg',
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } }
  }
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const c = out.contracts['SteakCoin.sol'].SteakCoin;
fs.writeFileSync('src/vm/templates/SteakCoin.bytecode.json', JSON.stringify({ abi: c.abi, bytecode: c.evm.bytecode.object, runtimeCode: c.evm.deployedBytecode.object }, null, 2));
console.log('ok, init:', c.evm.bytecode.object.length/2, 'bytes; runtime:', c.evm.deployedBytecode.object.length/2, 'bytes');
"
```
