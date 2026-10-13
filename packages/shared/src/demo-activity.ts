/** Isolated task wallets used only for explicitly labelled, real devnet demo activity. */
export const demoActivityNetwork = 'devnet' as const
export const demoActivityWallets = [
  {
    index: 1,
    wallet: '72jqaWv9tVzC3dH1Pjmg6zXS5iYbteVQ2eprgCuaDmbR',
    label: 'Clout Demo 1',
  },
  {
    index: 2,
    wallet: 'DyVWBPC8AtUStNqjLG9H6LtdrcgPc5FVJNsjtyK6jbph',
    label: 'Clout Demo 2',
  },
  {
    index: 3,
    wallet: 'HFWuZKsvCbYiMYfvuM7sLZ8hF45FAwHBwj76JTzKHPBN',
    label: 'Clout Demo 3',
  },
  {
    index: 4,
    wallet: '23v5fzeNAPiac9VUY563vvj1jbHpZERSuxwjorj4aioR',
    label: 'Clout Demo 4',
  },
] as const
