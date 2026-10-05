/** Model registration owns a bounded metadata draft, never a pasted credential. */
export function createModelSetup(presets, api) {
  let draft = null, revision = 0, generation = 0, saving = null;
  const preset = (key) => presets.find((item) => item.key === key);
  const trim = (value) => String(value ?? '').trim();
  function opened() { if (!draft) throw new Error('请先打开模型配置'); return draft; }
  return {
    open(input = {}) {
      revision++;
      generation++;
      const editing = input.editing;
      const selected = input.preset || (editing ? 'custom' : null);
      const defaults = preset(selected);
      draft = {
        step: input.step || (editing ? 2 : 1), preset: selected,
        editing: editing ? { id: editing.id } : null,
        name: trim(input.name || (editing && editing.name) || (defaults && defaults.label)),
        model: trim(input.model || (editing && editing.model)),
        baseUrl: trim(input.baseUrl || (editing && editing.baseUrl) || (defaults && defaults.baseUrl)),
        protocol: input.protocol || (editing && editing.protocol) || (defaults && defaults.protocol) || 'openai-compatible',
        env: input.env || (editing && editing.apiKeyEnv) || (defaults && defaults.env) || 'CRAFT_API_KEY',
      };
      if (![1, 2, 3].includes(draft.step) || (selected && !defaults)) { draft = null; throw new Error('模型配置步骤或服务商无效'); }
    },
    view() { return structuredClone(opened()); },
    change(event) {
      const current = opened();
      const previous = JSON.stringify(current);
      if (event.type === 'select') {
        const selected = preset(event.key);
        if (!selected) throw new Error('服务商不存在');
        Object.assign(current, { preset: selected.key, name: selected.label, model: selected.models[0] || '', baseUrl: selected.baseUrl,
          protocol: selected.protocol, env: selected.env, step: 2 });
      } else if (event.type === 'fields') {
        for (const key of ['name', 'baseUrl', 'protocol', 'env']) if (event[key] !== undefined) current[key] = trim(event[key]);
        current.baseUrl = current.baseUrl.replace(/\/+$/, '');
      } else if (event.type === 'next') {
        if (!current.preset) throw new Error('请先选择服务商');
        if (current.step === 1) current.step = 2;
        else {
          current.model = trim(event.model);
          if (!current.model) throw new Error('请选择或填写一个模型');
          current.step = 3;
        }
      } else if (event.type === 'back') current.step = Math.max(1, current.step - 1);
      else throw new Error('模型配置操作无效');
      if (JSON.stringify(current) !== previous) revision++;
    },
    async save() {
      const current = opened(), version = revision;
      if (saving && saving.generation === generation) throw new Error('模型配置正在保存');
      const body = { id: current.editing ? current.editing.id : current.preset, name: current.name || preset(current.preset)?.label || '', protocol: current.protocol,
        baseUrl: current.baseUrl, model: current.model, apiKeyEnv: current.env, supportsTools: true };
      if (!body.id || !/^[a-z0-9-]+$/.test(body.id)) throw new Error('服务商标识只能用小写字母、数字和短横线');
      if (!body.model) throw new Error('请选择或填写一个模型');
      if (!/^https?:\/\//.test(body.baseUrl)) throw new Error('服务地址要以 http:// 或 https:// 开头');
      const endpoint = new URL(body.baseUrl);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('服务地址不能包含密钥或认证参数');
      if (!['openai-compatible', 'anthropic'].includes(body.protocol)) throw new Error('接口协议无效');
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(body.apiKeyEnv)) throw new Error('环境变量名格式不正确');
      const ticket = { generation }; saving = ticket;
      let result;
      try {
        await api(current.editing ? '/api/config/models/' + encodeURIComponent(current.editing.id) : '/api/config/models',
          { method: current.editing ? 'PATCH' : 'POST', body });
        result = { current: version === revision, status: 'saved', provider: body.id, name: body.name, editing: !!current.editing };
      } catch (error) {
        if (version !== revision) result = { current: false, status: 'failed' };
        else throw error;
      } finally { if (saving === ticket) saving = null; }
      return result;
    },
  };
}
