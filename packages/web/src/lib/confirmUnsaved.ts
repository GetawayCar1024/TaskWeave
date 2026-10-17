import { h } from 'vue';
import { NButton, NSpace, type DialogApi } from 'naive-ui';

export function unsavedChoice(dialog: DialogApi, title: string, content: string, labels: { save: string; discard: string; cancel: string }): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise(resolve => {
    const choose = (value: 'save' | 'discard' | 'cancel') => { resolve(value); box.destroy(); };
    const box = dialog.warning({ title, content, maskClosable: false,
      onClose: () => resolve('cancel'), onEsc: () => resolve('cancel'),
      action: () => h(NSpace, {}, () => [
        h(NButton, { onClick: () => choose('cancel') }, () => labels.cancel),
        h(NButton, { onClick: () => choose('discard') }, () => labels.discard),
        h(NButton, { type: 'primary', onClick: () => choose('save') }, () => labels.save),
      ]),
    });
  });
}
