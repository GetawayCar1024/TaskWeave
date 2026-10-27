window.brandRoundTwo = {
  names: [
    { name: 'CaseWeave', caption: '当前首选', description: '保留你更倾向的方向。能涵盖测试点组织、子任务关系与平台交换。' },
    { name: 'CaseLoom', caption: '更短、更紧凑', description: 'Loom 是织机，像把零散测试数据组织成完整题包的工具。' },
    { name: 'Casewright', caption: '偏专业制作工具', description: 'Wright 表示制作者，更强调出题、构建和精加工。' },
    { name: 'TaskWeave', caption: '更强调题目整体', description: '从测试数据扩展到题面、解法和比赛组织，范围比 Case 更宽。' },
    { name: 'Setwise', caption: '简短、偏抽象', description: '来自集合与条理，适合测试集和子任务管理，也便于后续拓展。' },
    { name: 'CaseKit', caption: '直接、易记', description: '一套处理题目数据的工具箱，读写简单，含义直观。' },
  ],
  palettes: {
    indigo: { label: 'Indigo', top: '#536DE6', bottom: '#3545BB', mark: '#F5F7FF', accent: '#B5C4FF', outline: '#7286EC' },
    graphite: { label: 'Graphite', top: '#485366', bottom: '#263143', mark: '#F4F6FA', accent: '#B6C3D8', outline: '#627087' },
    teal: { label: 'Teal', top: '#288995', bottom: '#12606F', mark: '#F0FBFB', accent: '#9DDCE0', outline: '#4B9FAA' },
    porcelain: { label: 'Porcelain', top: '#FFFFFF', bottom: '#E6EBF8', mark: '#3F54C3', accent: '#8396DF', outline: '#D7DFF0' },
  },
  marks: [
    {
      id: 'A', key: 'loop', title: 'Open loop', caption: '更克制的 C 形标识',
      description: '外圈像一条收拢的路径，开口和短横形成独立的记忆点。大轮廓优先，小尺寸也清楚。',
      recommended: true,
      paths: '<path d="M183 76A73 73 0 1 0 183 180" fill="none" stroke="var(--mark)" stroke-width="32" stroke-linecap="round"/><path d="M134 128H199" fill="none" stroke="var(--mark)" stroke-width="26" stroke-linecap="round"/><path d="M171 128H199" fill="none" stroke="var(--accent)" stroke-width="26" stroke-linecap="round"/>',
    },
    {
      id: 'B', key: 'monogram', title: 'CW monogram', caption: '字母融合，更像专属软件标志',
      description: '把 C 的边框与 W 的折线合在一起。更贴近 CaseWeave 名字，视觉也偏开发工具。',
      paths: '<path d="M120 65H61V191H120" fill="none" stroke="var(--mark)" stroke-width="26" stroke-linejoin="round"/><path d="M107 88L128 171L154 126L178 171L201 88" fill="none" stroke="var(--mark)" stroke-width="23" stroke-linejoin="round"/><path d="M187 139L201 88" stroke="var(--accent)" stroke-width="23"/>',
    },
    {
      id: 'C', key: 'shuttle', title: 'Shuttle', caption: '用织梭表达 Weave',
      description: '不再直接画交叉线，用织梭的眼形轮廓表达编织。偏轻巧、流畅，也适合 CaseLoom。',
      paths: '<path fill="var(--mark)" fill-rule="evenodd" d="M39 128Q128 15 217 128Q128 241 39 128ZM91 128Q128 85 165 128Q128 171 91 128Z"/><path d="M43 128Q91 189 128 195Q165 189 213 128" fill="none" stroke="var(--accent)" stroke-width="9" stroke-linejoin="round"/>',
    },
    {
      id: 'D', key: 'fold', title: 'Fold', caption: '更立体的折带轮廓',
      description: '一条有折面的带子构成紧凑符号。形体更鲜明，偏桌面应用图标的质感。',
      paths: '<path d="M59 65H102L151 191H108Z" fill="var(--accent)"/><path d="M109 65H195L148 191H106L140 105H109Z" fill="var(--mark)"/><path d="M109 65L140 105H181L195 65Z" fill="var(--mark)"/><path d="M106 191H148L133 151Z" fill="var(--accent)"/>',
    },
    {
      id: 'E', key: 'interlock', title: 'Interlock', caption: '更抽象的交织结构',
      description: '两组粗线条以留白穿插，避免细碎节点。强调编排与连接，可独立于名字使用。',
      recommended: true,
      paths: '<path d="M66 66H159V97H97V159H66Z" fill="var(--mark)"/><path d="M190 190H97V159H159V97H190Z" fill="var(--mark)"/><path d="M159 66H190V97H159Z" fill="var(--accent)"/><path d="M66 159H97V190H66Z" fill="var(--accent)"/><path d="M113 113H143V143H113Z" fill="var(--mark)"/>',
    },
    {
      id: 'F', key: 'bridge', title: 'Bridge', caption: '偏导入导出的接口感',
      description: '一组相扣的开口模块，中间是数据通路。更冷静、工程化，适合强调平台互通。',
      paths: '<path d="M101 62H60V194H101V166H88V90H101Z" fill="var(--mark)"/><path d="M155 62H196V194H155V166H168V90H155Z" fill="var(--mark)"/><path d="M90 114H166V142H90Z" fill="var(--accent)"/><path d="M113 103H143V153H113Z" fill="var(--mark)"/>',
    },
  ],
};
