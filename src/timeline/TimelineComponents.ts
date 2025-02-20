import { App, Modal, Setting, TextComponent } from 'obsidian';

export class TimeBlockModal extends Modal {
    private title: string = '';
    private resolvePromise: ((value: string | null) => void) | null = null;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h3', { text: 'Create Time Block' });

        const textComponent = new Setting(contentEl)
            .setName('Title')
            .addText((text: TextComponent) => text
                .setValue(this.title)
                .onChange((value: string) => this.title = value));

        const inputEl = (textComponent.components[0] as TextComponent).inputEl as HTMLInputElement;

        // Focus and select all text
        inputEl.focus();
        
        // Handle Enter key
        inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter') {
                if (this.resolvePromise) {
                    this.resolvePromise(this.title || null);
                }
                this.close();
            }
        });

        // Remove the buttons, just use Enter/Escape
        contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (this.resolvePromise) {
                    this.resolvePromise(null);
                }
                this.close();
            }
        });
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

export function setupSplitter(
    splitter: HTMLElement, 
    timelineEl: HTMLElement, 
    unscheduledEl: HTMLElement
) {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    splitter.addEventListener('mousedown', (e: MouseEvent) => {
        isResizing = true;
        startY = e.clientY;
        startHeight = timelineEl.offsetHeight;
        document.body.addClass('timeline-resizing');
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e: MouseEvent) => {
        if (!isResizing) return;

        const deltaY = e.clientY - startY;
        const newHeight = Math.max(200, startHeight + deltaY); // Minimum height of 200px
        
        timelineEl.style.height = `${newHeight}px`;
        timelineEl.style.flex = '0 0 auto';
        unscheduledEl.style.flex = '1 1 auto';
    });

    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            document.body.removeClass('timeline-resizing');
        }
    });
} 