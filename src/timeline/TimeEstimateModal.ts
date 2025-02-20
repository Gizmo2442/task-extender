import { App, Modal, Setting, TextComponent, ButtonComponent } from 'obsidian';

export class TimeEstimateModal extends Modal {
    private timeEstimate: string = '';
    private resolvePromise: ((value: string | null) => void) | null = null;
    private textComponent: TextComponent | null = null;
    private buttonComponent: ButtonComponent | null = null;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Set Time Estimate' });

        const textComponent = new Setting(contentEl)
            .setName('Time Estimate')
            .setDesc('Format: 1d 2h 30m (days, hours, minutes)')
            .addText((text: TextComponent) => {
                this.textComponent = text;
                return text
                    .setValue(this.timeEstimate)
                    .onChange((value: string) => {
                        this.timeEstimate = value;
                        this.validateAndUpdateButton();
                    });
            });

        // Add OK button
        const buttonSetting = new Setting(contentEl)
            .addButton(button => {
                this.buttonComponent = button;
                return button
                    .setButtonText('OK')
                    .setCta()
                    .onClick(() => {
                        if (this.validateTimeFormat()) {
                            if (this.resolvePromise) {
                                this.resolvePromise(`⏱️ ${this.timeEstimate}`);
                            }
                            this.close();
                        }
                    });
            });

        const inputEl = (textComponent.components[0] as TextComponent).inputEl as HTMLInputElement;
        inputEl.focus();

        this.validateAndUpdateButton();
    }

    private validateTimeFormat(): boolean {
        const regex = /^(?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?$/;
        const match = this.timeEstimate.trim().match(regex);
        
        if (!match) return false;
        
        const [_, days, hours, minutes] = match;
        return !!(days || hours || minutes); // At least one value must be present
    }

    private validateAndUpdateButton() {
        if (!this.buttonComponent) return;

        const isValid = this.validateTimeFormat();
        this.buttonComponent.setDisabled(!isValid);
        
        const buttonEl = this.buttonComponent.buttonEl;
        if (isValid) {
            buttonEl.removeClass('invalid');
        } else {
            buttonEl.addClass('invalid');
        }
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.resolvePromise) {
            this.resolvePromise(null);
        }
    }

    async openAndGetValue(): Promise<string | null> {
        this.open();
        return new Promise(resolve => {
            this.resolvePromise = resolve;
        });
    }
}