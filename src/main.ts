import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, View } from 'obsidian';
import { TimelineView } from './timeline/TimelineView';

interface TaskPlannerSettings {
    originalDateEmoji: string;
    timeEstimateEmoji: string;
}

const DEFAULT_SETTINGS: TaskPlannerSettings = {
    originalDateEmoji: '📋', // for original date (using clipboard emoji to differentiate from regular due date)
    timeEstimateEmoji: '⏱️', // for time estimates
}

export default class TaskPlannerPlugin extends Plugin {
    settings: TaskPlannerSettings;

    async onload() {
        console.log('Loading Task Planner Plugin');
        await this.loadSettings();

        // Register Timeline View
        this.registerView(
            'timeline-view',
            (leaf: WorkspaceLeaf) => {
                console.log('Creating new timeline view');
                return new TimelineView(leaf, this);
            }
        );

        // Add ribbon icon for timeline
        const ribbonIcon = this.addRibbonIcon('calendar-clock', 'Open Task Timeline', (evt: MouseEvent) => {
            console.log('Clicked timeline ribbon icon');
            this.activateView();
        });
        console.log('Added ribbon icon');

        // Add settings tab
        this.addSettingTab(new TaskPlannerSettingTab(this.app, this));

        // Register timeBlocks code block processor
        this.registerMarkdownCodeBlockProcessor('timeBlocks', (source, el, ctx) => {
            // Create container
            const container = el.createEl('div', { cls: 'timeblocks-container' });
            
            // Create title section
            const titleSection = container.createEl('div', { cls: 'timeblocks-title' });
            titleSection.createEl('span', { text: 'TimeBlocks', cls: 'timeblocks-label' });
            
            // Store the source in a hidden element
            const sourceEl = container.createEl('div', { 
                cls: 'timeblocks-source',
                attr: { style: 'display: none;' }
            });
            sourceEl.setText(source);
        });
    }

    onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateView() {
        console.log('Activating timeline view');
        const { workspace } = this.app;
        
        let leaf = workspace.getLeavesOfType('timeline-view')[0];
        console.log('Existing leaf:', leaf);
        
        if (!leaf) {
            console.log('Creating new leaf');
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({
                    type: 'timeline-view',
                    active: true,
                });
                leaf = rightLeaf;
                console.log('Created new leaf');
            } else {
                console.log('Failed to get right leaf');
            }
        }
        
        if (leaf) {
            workspace.revealLeaf(leaf);
            console.log('Revealed leaf');
        }
    }
}

class TaskPlannerSettingTab extends PluginSettingTab {
    plugin: TaskPlannerPlugin;

    constructor(app: App, plugin: TaskPlannerPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('Original Date Emoji')
            .setDesc('Emoji used to mark the original due date of a task')
            .addText(text => text
                .setValue(this.plugin.settings.originalDateEmoji)
                .onChange(async (value) => {
                    this.plugin.settings.originalDateEmoji = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Time Estimate Emoji')
            .setDesc('Emoji used to mark time estimates for tasks')
            .addText(text => text
                .setValue(this.plugin.settings.timeEstimateEmoji)
                .onChange(async (value) => {
                    this.plugin.settings.timeEstimateEmoji = value;
                    await this.plugin.saveSettings();
                }));
    }
} 