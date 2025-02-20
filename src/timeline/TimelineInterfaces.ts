import type { TFile, Component } from 'obsidian';
import type { TaskManager } from './TaskManager';
import type TaskPlannerPlugin from '../main';

export interface ITimelineView extends Component {
    getPlugin(): TaskPlannerPlugin;
    getTimelineEl(): HTMLElement;
    getCurrentDayFile(): TFile | null;
    getTaskManager(): TaskManager;
} 